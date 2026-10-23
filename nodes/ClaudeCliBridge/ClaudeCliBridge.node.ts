import { execFile, ExecFileException } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// Types only: nothing from n8n-workflow is loaded at run time, so the package
// has no dependencies at all, peer ones included. A peer dependency made npm
// install (or, with --legacy-peer-deps, remove) a second n8n-workflow copy in
// n8n's community-node folder, and pulled n8n-workflow's whole tree into
// supply-chain scanners' view of this package.
import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription, IDataObject } from 'n8n-workflow';

import { AttachmentError, AttachmentInfo, convertToJpeg, sniff, toContentBlock } from './attachments';
import { buildStreamArgs, CliError, extractJson, JsonParseError, runClaudeStream } from './cli';

// A setup mistake on the node or the item (missing binary field and the like).
// Never retried. n8n wraps any thrown Error into its own node error.
class ConfigError extends Error {}

const itemLabel = (i: number, total: number) => (total > 1 ? ` [item ${i}]` : '');

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new CliError('Execution was cancelled', '', true));
		const onAbort = () => {
			clearTimeout(t);
			reject(new CliError('Execution was cancelled', '', true));
		};
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

const execFileAsync = promisify(execFile);

function runClaude(
	cliPath: string,
	args: string[],
	options: { timeout: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			cliPath,
			args,
			{ timeout: options.timeout, maxBuffer: 1024 * 1024 * 10, env: options.env },
			(error: ExecFileException | null, stdout: string, stderr: string) => {
				if (error) {
					reject(error);
					return;
				}
				resolve({ stdout, stderr });
			},
		);
		child.stdin?.end();
	});
}

async function extractPdfText(pdfBuffer: Buffer, maxChars = 4000): Promise<string | null> {
	const tmpFile = path.join(os.tmpdir(), `claude-cli-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
	try {
		await fs.writeFile(tmpFile, pdfBuffer);
		const { stdout } = await execFileAsync('pdftotext', [tmpFile, '-'], { maxBuffer: 1024 * 1024 * 10 });
		return stdout.trim().slice(0, maxChars);
	} catch {
		return null;
	} finally {
		await fs.unlink(tmpFile).catch(() => {});
	}
}

function cliEnv(credentials: IDataObject): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const homeDir = (credentials.homeDir as string) || process.env.HOME;
	if (homeDir) env.HOME = homeDir;
	const configDir = ((credentials.configDir as string) || '').trim();
	if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
	const token = ((credentials.oauthToken as string) || '').trim();
	if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
	return env;
}

const v1Only = { '@version': [1] };
const v2Only = { '@version': [2] };

export class ClaudeCliBridge implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Claude CLI',
		name: 'claudeCliBridge',
		icon: 'fa:robot',
		group: ['transform'],
		version: [1, 2],
		defaultVersion: 2,
		subtitle: '={{$parameter["prompt"].substring(0,50)}}',
		description:
			'Call the locally-installed, subscription-authenticated Claude CLI directly (no Anthropic API key). Version 2 sends images, PDFs and text files to Claude as they are.',
		defaults: { name: 'Claude CLI' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'claudeCliBridgeApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				description: 'The instruction for Claude. Attachments, if any, are sent before it in the same message.',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: '',
				placeholder: 'claude-sonnet-5-5',
				description: 'Optional model id passed as --model. Leave empty for the CLI default.',
			},

			// ---- version 1 (unchanged) ----
			{
				displayName: 'Attach PDF',
				name: 'attachPdf',
				type: 'boolean',
				default: false,
				displayOptions: { show: v1Only },
				description:
					'Whether to extract text from a PDF in binary input data (via pdftotext) and append it to the prompt',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: { show: { ...v1Only, attachPdf: [true] } },
				description: 'Name of the binary property containing the PDF file',
			},
			{
				displayName: 'Timeout (ms)',
				name: 'timeout',
				type: 'number',
				default: 120000,
				displayOptions: { show: v1Only },
				description: 'Kill the claude process if it has not finished within this time',
			},

			// ---- version 2 ----
			{
				displayName: 'Attachments',
				name: 'attachmentMode',
				type: 'options',
				default: 'none',
				displayOptions: { show: v2Only },
				options: [
					{ name: 'None', value: 'none' },
					{ name: 'Selected Binary Fields', value: 'selected' },
					{ name: 'All Binary Fields', value: 'all' },
				],
				description:
					'Binary files to send to Claude as they are: JPEG, PNG, GIF and WEBP as images, PDF as a document (Claude reads the page images, not only a text layer), plain text as a text document. The type is detected from the file bytes.',
			},
			{
				displayName: 'Binary Fields',
				name: 'binaryFields',
				type: 'string',
				default: 'data',
				displayOptions: { show: { ...v2Only, attachmentMode: ['selected'] } },
				description: 'Comma-separated binary property names, e.g. "data" or "receipt, invoice"',
			},
			{
				displayName: 'Response Format',
				name: 'responseFormat',
				type: 'options',
				default: 'text',
				displayOptions: { show: v2Only },
				options: [
					{ name: 'Text', value: 'text' },
					{
						name: 'JSON',
						value: 'json',
						description: 'Parse JSON out of the answer into the "data" field (a ```json fence or surrounding prose is tolerated)',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: v2Only },
				options: [
					{
						displayName: 'System Prompt',
						name: 'systemPrompt',
						type: 'string',
						typeOptions: { rows: 4 },
						default: '',
					},
					{
						displayName: 'System Prompt Mode',
						name: 'systemPromptMode',
						type: 'options',
						default: 'append',
						options: [
							{ name: 'Append to Claude Code Default', value: 'append' },
							{ name: 'Replace Claude Code Default', value: 'replace' },
						],
					},
					{
						displayName: 'Tools',
						name: 'toolsMode',
						type: 'options',
						default: 'none',
						options: [
							{
								name: 'None (Pure Model Call)',
								value: 'none',
								description:
									'No built-in tools, no MCP servers, no settings files or hooks, no skills. Fast and predictable.',
							},
							{
								name: 'CLI Defaults',
								value: 'default',
								description: 'Whatever the CLI user has configured (tools, MCP servers, hooks)',
							},
						],
					},
					{
						displayName: 'Effort',
						name: 'effort',
						type: 'options',
						default: '',
						options: [
							{ name: 'CLI Default', value: '' },
							{ name: 'Low', value: 'low' },
							{ name: 'Medium', value: 'medium' },
							{ name: 'High', value: 'high' },
							{ name: 'Extra High', value: 'xhigh' },
							{ name: 'Max', value: 'max' },
						],
						description: 'Passed as --effort: how much the model thinks before answering. Higher is slower and uses more of the subscription quota.',
					},
					{
						displayName: 'Retries',
						name: 'retries',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 5 },
						default: 0,
						description:
							'How many times to run the CLI again when it fails or the answer is not valid JSON. Works with Continue On Fail too, unlike n8n\'s own Retry On Fail. File and setup errors are not retried.',
					},
					{
						displayName: 'Retry Wait (ms)',
						name: 'retryWaitMs',
						type: 'number',
						default: 5000,
						description: 'Pause before each retry',
					},
					{
						displayName: 'Convert HEIC/AVIF',
						name: 'convertHeic',
						type: 'boolean',
						default: true,
						description:
							'Whether to convert HEIC/HEIF/AVIF attachments (iPhone photos) to JPEG with GraphicsMagick before sending them. Claude does not accept these formats. The official n8n Docker image includes GraphicsMagick.',
					},
					{
						displayName: 'GraphicsMagick Path',
						name: 'gmPath',
						type: 'string',
						default: 'gm',
						description: 'The gm binary used for HEIC/AVIF conversion',
					},
					{
						displayName: 'Max Turns',
						name: 'maxTurns',
						type: 'number',
						default: 0,
						description: 'Passed as --max-turns when greater than 0',
					},
					{
						displayName: 'Timeout (ms)',
						name: 'timeout',
						type: 'number',
						default: 180000,
						description: 'Kill the claude process if it has not finished within this time',
					},
					{
						displayName: 'Working Directory',
						name: 'workingDirectory',
						type: 'string',
						default: '',
						description: 'Directory the CLI runs in. Defaults to the system temp directory.',
					},
					{
						displayName: 'Keep Binary Data',
						name: 'keepBinary',
						type: 'boolean',
						default: true,
						description: 'Whether to pass the input item binary data through to the output',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const typeVersion = this.getNode().typeVersion;
		if (typeVersion < 2) return executeV1.call(this);
		return executeV2.call(this);
	}
}

async function executeV1(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const returnData: INodeExecutionData[] = [];
	const credentials = await this.getCredentials('claudeCliBridgeApi');
	const cliPath = (credentials.cliPath as string) || process.env.CLAUDE_CLI_PATH || 'claude';
	const env = cliEnv(credentials);

	for (let i = 0; i < items.length; i++) {
		let prompt = this.getNodeParameter('prompt', i) as string;
		const model = this.getNodeParameter('model', i) as string;
		const attachPdf = this.getNodeParameter('attachPdf', i) as boolean;
		const timeout = this.getNodeParameter('timeout', i) as number;

		if (attachPdf) {
			const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
			const binaryDataBuffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
			const pdfText = await extractPdfText(binaryDataBuffer);
			if (pdfText) {
				prompt = `${prompt}\n\nPDF content:\n${pdfText}`;
			}
		}

		const args = [...(model ? ['--model', model] : []), '-p', prompt];

		try {
			const { stdout, stderr } = await runClaude(cliPath, args, { timeout, env });
			returnData.push({
				json: { success: true, output: stdout.trim(), error: stderr.trim() } as IDataObject,
				pairedItem: { item: i },
			});
		} catch (error) {
			if (this.continueOnFail()) {
				returnData.push({
					json: { success: false, output: '', error: (error as Error).message },
					pairedItem: { item: i },
				});
				continue;
			}
			throw new Error((error as Error).message + itemLabel(i, items.length));
		}
	}

	return [returnData];
}

async function executeV2(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const returnData: INodeExecutionData[] = [];
	const credentials = await this.getCredentials('claudeCliBridgeApi');
	const cliPath = ((credentials.cliPath as string) || process.env.CLAUDE_CLI_PATH || 'claude').trim();
	const env = cliEnv(credentials);
	const signal = typeof this.getExecutionCancelSignal === 'function' ? this.getExecutionCancelSignal() : undefined;

	for (let i = 0; i < items.length; i++) {
		const options = this.getNodeParameter('options', i, {}) as IDataObject;
		const keepBinary = options.keepBinary !== false;
		const base = (json: IDataObject): INodeExecutionData => ({
			json,
			...(keepBinary && items[i].binary ? { binary: items[i].binary } : {}),
			pairedItem: { item: i },
		});
		let output = '';
		let attempts = 0;
		const attachments: AttachmentInfo[] = [];

		try {
			const prompt = this.getNodeParameter('prompt', i) as string;
			const model = ((this.getNodeParameter('model', i, '') as string) || '').trim();
			const mode = this.getNodeParameter('attachmentMode', i, 'none') as string;
			const responseFormat = this.getNodeParameter('responseFormat', i, 'text') as string;

			const content: Array<Record<string, unknown>> = [];
			if (mode !== 'none') {
				const available = Object.keys(items[i].binary || {});
				const fields =
					mode === 'all'
						? available
						: String(this.getNodeParameter('binaryFields', i, 'data'))
								.split(',')
								.map((s) => s.trim())
								.filter(Boolean);
				if (fields.length === 0) {
					throw new ConfigError('No binary data to attach on this item');
				}
				for (const field of fields) {
					const meta = items[i].binary?.[field];
					if (!meta) {
						throw new ConfigError(`Binary field "${field}" not found (item has: ${available.join(', ') || 'none'})`);
					}
					let buf = await this.helpers.getBinaryDataBuffer(i, field);
					let s = sniff(buf, meta.mimeType);
					let convertedFrom: string | undefined;
					if (s.convertFrom) {
						if (options.convertHeic === false) {
							throw new AttachmentError(
								`${s.convertFrom.toUpperCase()} images are not accepted by Claude, and Options → Convert HEIC/AVIF is off.`,
							);
						}
						const gmPath = ((options.gmPath as string) || 'gm').trim();
						convertedFrom = s.convertFrom;
						buf = await convertToJpeg(buf, s.convertFrom, gmPath, 60000);
						s = { kind: 'image', mediaType: 'image/jpeg' };
					}
					content.push(toContentBlock(buf, s, meta.fileName));
					attachments.push({ field, fileName: meta.fileName, kind: s.kind, mediaType: s.mediaType, bytes: buf.length, ...(convertedFrom ? { convertedFrom } : {}) });
				}
			}
			content.push({ type: 'text', text: prompt });

			const args = buildStreamArgs({
				model: model || undefined,
				systemPrompt: options.systemPrompt as string | undefined,
				systemPromptMode: (options.systemPromptMode as 'append' | 'replace') || 'append',
				pureInference: (options.toolsMode || 'none') === 'none',
				maxTurns: options.maxTurns as number | undefined,
				effort: (options.effort as string) || undefined,
			});
			// Retried: a CLI failure (no result, error result, timeout) and an answer
			// that is not valid JSON when JSON was asked for. Not retried: setup and
			// file errors (they fail the same way every time) and a cancelled run.
			// n8n's own Retry On Fail never fires under Continue On Fail, because
			// the error is turned into an output item here instead of thrown.
			const retries = Math.max(0, Math.min(5, Math.floor(Number(options.retries) || 0)));
			const retryWaitMs = Math.max(0, Number(options.retryWaitMs ?? 5000) || 0);
			for (;;) {
				attempts++;
				try {
					const r = await runClaudeStream({
						cliPath,
						args,
						env,
						cwd: ((options.workingDirectory as string) || '').trim() || os.tmpdir(),
						content,
						timeoutMs: (options.timeout as number) || 180000,
						signal,
					});
					output = r.text;
					if (r.isError) {
						// An auth failure comes back as subtype 'success' with is_error set;
						// only a real error subtype (error_max_turns, ...) is worth naming.
						const kind = r.subtype && r.subtype !== 'success' ? ` (${r.subtype})` : '';
						throw new CliError(`Claude CLI reported an error${kind}: ${r.text || 'no message'}`, r.stderr);
					}
					const json: IDataObject = {
						success: true,
						output: r.text,
						model: r.model,
						durationMs: r.durationMs,
						costUsd: r.costUsd,
						usage: r.usage as IDataObject,
						attempts,
						attachments: attachments as unknown as IDataObject[],
					};
					if (responseFormat === 'json') json.data = extractJson(r.text) as IDataObject;
					returnData.push(base(json));
					break;
				} catch (error) {
					const retryable = (error instanceof CliError && !error.cancelled) || error instanceof JsonParseError;
					if (!retryable || attempts > retries) throw error;
					await sleep(retryWaitMs, signal);
				}
			}
		} catch (error) {
			const message = (error as Error).message;
			if (this.continueOnFail()) {
				returnData.push(
					base({ success: false, output, error: message, attempts, attachments: attachments as unknown as IDataObject[] }),
				);
				continue;
			}
			throw new Error(message + itemLabel(i, items.length));
		}
	}

	return [returnData];
}
