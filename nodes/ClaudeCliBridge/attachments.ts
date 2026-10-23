import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Turns n8n binary properties into Anthropic content blocks the CLI accepts on
// `--input-format stream-json`. The type is decided from the bytes, not from
// the declared mime type: browsers and mobile web builds routinely label every
// upload `image/jpeg` (a PDF included), and the API rejects a block whose
// media_type does not match its content.

export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface SniffResult {
	kind: AttachmentKind;
	mediaType: string;
	// Bytes to drop before the content starts (a PDF header after leading junk).
	offset?: number;
	// Set for HEIC/HEIF/AVIF: Claude does not take these, they are converted to
	// JPEG first (convertToJpeg).
	convertFrom?: 'heic' | 'avif';
}

export interface AttachmentInfo {
	field: string;
	fileName?: string;
	kind: AttachmentKind;
	mediaType: string;
	bytes: number;
	convertedFrom?: string;
}

// The Messages API takes at most 5 MB per image, but the CLI downsizes large
// images before sending them: a 29 MB JPEG went through on CLI 2.1.301 and
// 2.1.304. The image limit here only keeps memory in check, like the PDF one.
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const TEXT_MIME = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-ndjson))/i;

export class AttachmentError extends Error {}

export function sniff(buf: Buffer, declaredMime?: string): SniffResult {
	const b = buf;
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mediaType: 'image/jpeg' };
	if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { kind: 'image', mediaType: 'image/png' };
	}
	if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) {
		return { kind: 'image', mediaType: 'image/gif' };
	}
	if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
		return { kind: 'image', mediaType: 'image/webp' };
	}
	// The PDF spec allows the header anywhere in the first 1024 bytes (mail
	// gateways and scanners sometimes prepend a few). The API cannot read such a
	// file as is -- the CLI does not fail, the model just never sees the pages --
	// so toContentBlock drops the bytes before the header.
	const pdfAt = b.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1');
	if (pdfAt >= 0) return { kind: 'pdf', mediaType: 'application/pdf', ...(pdfAt > 0 ? { offset: pdfAt } : {}) };
	if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
		const brand = b.subarray(8, 12).toString('latin1');
		if (/^(avif|avis)$/.test(brand)) return { kind: 'image', mediaType: 'image/jpeg', convertFrom: 'avif' };
		if (/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(brand)) return { kind: 'image', mediaType: 'image/jpeg', convertFrom: 'heic' };
	}
	if (declaredMime && TEXT_MIME.test(declaredMime)) return { kind: 'text', mediaType: 'text/plain' };
	throw new AttachmentError(
		`Unsupported attachment type (declared "${declaredMime || 'none'}"). Supported: JPEG, PNG, GIF, WEBP, HEIC/AVIF (converted to JPEG), PDF and plain text.`,
	);
}

// iPhones save photos as HEIC, and the Messages API does not take HEIC or
// AVIF. GraphicsMagick reads both through libheif and ships with the official
// n8n Docker image (the Edit Image node uses it), so no npm dependency is
// needed. Its HEIF reader cannot read from a pipe ("Memory allocation failed"
// on stdin, GraphicsMagick 1.3.47), so the image goes to a private temp
// directory that is removed right after; the JPEG comes back on stdout.
// -auto-orient applies the rotation that HEIC photos rely on.
export async function convertToJpeg(buf: Buffer, from: 'heic' | 'avif', gmPath: string, timeoutMs: number): Promise<Buffer> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-cli-bridge-'));
	try {
		const file = path.join(dir, `input.${from}`);
		await fs.writeFile(file, buf, { mode: 0o600 });
		return await runGm(gmPath, ['convert', `${from}:${file}`, '-auto-orient', '-quality', '90', 'jpeg:-'], from, timeoutMs);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

function runGm(gmPath: string, args: string[], from: string, timeoutMs: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const fail = (why: string) =>
			reject(
				new AttachmentError(
					`Could not convert the ${from.toUpperCase()} image to JPEG with GraphicsMagick ("${gmPath}"): ${why}. ` +
						'Install GraphicsMagick with HEIF support on the n8n host, or convert the image before this node (e.g. Edit Image node).',
				),
			);
		const child = spawn(gmPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		let err = '';
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			child.kill('SIGKILL');
			fail(`no result within ${timeoutMs} ms`);
		}, timeoutMs);
		child.stdout.on('data', (d: Buffer) => out.push(d));
		child.stderr.on('data', (d: Buffer) => {
			if (err.length < 2000) err += d.toString();
		});
		child.on('error', (e: NodeJS.ErrnoException) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			fail(e.code === 'ENOENT' ? 'gm is not installed or not on PATH' : e.message);
		});
		child.on('close', (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			const jpg = Buffer.concat(out);
			if (code === 0 && jpg.length > 3 && jpg[0] === 0xff && jpg[1] === 0xd8) resolve(jpg);
			else fail(`exit code ${code}${err.trim() ? ', ' + err.trim().split('\n').slice(-2).join(' ') : ''}`);
		});
	});
}

export function toContentBlock(buf: Buffer, s: SniffResult, title?: string): Record<string, unknown> {
	if (s.kind === 'image') {
		if (buf.length > MAX_IMAGE_BYTES) {
			throw new AttachmentError(
				`Image is ${(buf.length / 1048576).toFixed(1)} MB; the limit here is 32 MB. Resize it first.`,
			);
		}
		return { type: 'image', source: { type: 'base64', media_type: s.mediaType, data: buf.toString('base64') } };
	}
	if (s.kind === 'pdf') {
		if (buf.length > MAX_PDF_BYTES) {
			throw new AttachmentError(`PDF is ${(buf.length / 1048576).toFixed(1)} MB; Claude accepts at most 32 MB.`);
		}
		const pdf = s.offset ? buf.subarray(s.offset) : buf;
		const block: Record<string, unknown> = {
			type: 'document',
			source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
		};
		if (title) block.title = title;
		return block;
	}
	if (buf.length > MAX_TEXT_BYTES) {
		throw new AttachmentError(`Text attachment is ${(buf.length / 1048576).toFixed(1)} MB; the limit here is 2 MB.`);
	}
	const block: Record<string, unknown> = {
		type: 'document',
		source: { type: 'text', media_type: 'text/plain', data: buf.toString('utf8') },
	};
	if (title) block.title = title;
	return block;
}
