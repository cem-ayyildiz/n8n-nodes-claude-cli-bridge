import { spawn } from 'child_process';

// One `claude --print` run fed through stdin as stream-json. That input format
// is what lets a message carry image and document blocks; a plain `-p "<text>"`
// argument can only ever carry text.

export interface StreamRunParams {
	cliPath: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
	content: Array<Record<string, unknown>>;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface StreamRunResult {
	text: string;
	isError: boolean;
	subtype: string;
	model?: string;
	sessionId?: string;
	durationMs?: number;
	costUsd?: number;
	numTurns?: number;
	usage?: Record<string, unknown>;
	stderr: string;
}

export class CliError extends Error {
	constructor(
		message: string,
		public readonly stderr: string = '',
		public readonly cancelled: boolean = false,
	) {
		super(message);
	}
}

export class JsonParseError extends Error {}

// Isolation for a pure model call: no built-in tools, no MCP servers, no
// settings files (so no hooks), no skills. Without these the CLI inherits
// whatever the host user configured -- on a workstation that meant every MCP
// server starting up and a 26 s round trip for a one-line answer.
export const PURE_INFERENCE_ARGS = ['--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands'];

const KILL_GRACE_MS = 5000;

export function buildStreamArgs(o: {
	model?: string;
	systemPrompt?: string;
	systemPromptMode?: 'append' | 'replace';
	pureInference: boolean;
	maxTurns?: number;
	effort?: string;
}): string[] {
	const args = [
		'--print',
		'--input-format', 'stream-json',
		'--output-format', 'stream-json',
		'--verbose',
		'--no-session-persistence',
	];
	if (o.model) args.push('--model', o.model);
	if (o.systemPrompt && o.systemPrompt.trim()) {
		args.push(o.systemPromptMode === 'replace' ? '--system-prompt' : '--append-system-prompt', o.systemPrompt.trim());
	}
	if (o.pureInference) args.push(...PURE_INFERENCE_ARGS);
	if (o.maxTurns && o.maxTurns > 0) args.push('--max-turns', String(o.maxTurns));
	if (o.effort) args.push('--effort', o.effort);
	return args;
}

export function runClaudeStream(p: StreamRunParams): Promise<StreamRunResult> {
	return new Promise((resolve, reject) => {
		let buf = '';
		let stderr = '';
		let model: string | undefined;
		let result: Record<string, any> | undefined;
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (p.signal) p.signal.removeEventListener('abort', onAbort);
			fn();
		};

		const child = spawn(p.cliPath, p.args, { env: p.env, cwd: p.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

		// SIGTERM first; a process that is still there after the grace period
		// gets SIGKILL, so a hung CLI cannot outlive the execution.
		const stop = () => {
			child.kill('SIGTERM');
			setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			}, KILL_GRACE_MS).unref();
		};
		const timer = setTimeout(() => {
			stop();
			finish(() => reject(new CliError(`claude did not finish within ${p.timeoutMs} ms`, stderr)));
		}, p.timeoutMs);
		const onAbort = () => {
			stop();
			finish(() => reject(new CliError('Execution was cancelled', stderr, true)));
		};
		if (p.signal) {
			if (p.signal.aborted) onAbort();
			else p.signal.addEventListener('abort', onAbort, { once: true });
		}

		const handleLine = (line: string) => {
			const t = line.trim();
			if (!t) return;
			let ev: Record<string, any>;
			try {
				ev = JSON.parse(t);
			} catch {
				return; // not an event line
			}
			if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') model = ev.model;
			if (ev.type === 'result') result = ev;
		};

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				handleLine(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			if (stderr.length < 20000) stderr += chunk;
		});
		child.on('error', (err) => finish(() => reject(new CliError(`Could not start "${p.cliPath}": ${err.message}`, stderr))));
		child.on('close', (code) => {
			if (buf) handleLine(buf);
			if (!result) {
				const tail = stderr.trim().split('\n').slice(-5).join(' | ');
				finish(() => reject(new CliError(`claude exited with code ${code} and no result${tail ? `: ${tail}` : ''}`, stderr)));
				return;
			}
			const r = result;
			finish(() =>
				resolve({
					text: typeof r.result === 'string' ? r.result : r.result == null ? '' : JSON.stringify(r.result),
					isError: !!r.is_error || r.subtype !== 'success',
					subtype: String(r.subtype || ''),
					model,
					sessionId: r.session_id,
					durationMs: r.duration_ms,
					costUsd: r.total_cost_usd,
					numTurns: r.num_turns,
					usage: r.usage,
					stderr,
				}),
			);
		});

		const message = { type: 'user', message: { role: 'user', content: p.content } };
		child.stdin.on('error', () => {
			/* the close handler reports the real failure */
		});
		child.stdin.end(JSON.stringify(message) + '\n');
	});
}

// The model is asked for JSON but may wrap it in prose or a ```json fence.
// Take the fenced block if there is one, else the first balanced {...} or [...].
export function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidates = fenced ? [fenced[1], text] : [text];
	for (const c of candidates) {
		const s = c.trim();
		try {
			return JSON.parse(s);
		} catch {
			/* fall through */
		}
		const start = s.search(/[{[]/);
		if (start < 0) continue;
		const open = s[start];
		const close = open === '{' ? '}' : ']';
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let i = start; i < s.length; i++) {
			const ch = s[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === '\\') esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === open) depth++;
			else if (ch === close && --depth === 0) {
				try {
					return JSON.parse(s.slice(start, i + 1));
				} catch {
					break;
				}
			}
		}
	}
	throw new JsonParseError('The answer did not contain valid JSON');
}
