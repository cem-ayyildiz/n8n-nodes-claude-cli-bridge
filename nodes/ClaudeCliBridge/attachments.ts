// Turns n8n binary properties into Anthropic content blocks the CLI accepts on
// `--input-format stream-json`. The type is decided from the bytes, not from
// the declared mime type: browsers and mobile web builds routinely label every
// upload `image/jpeg` (a PDF included), and the API rejects a block whose
// media_type does not match its content.

export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface SniffResult {
	kind: AttachmentKind;
	mediaType: string;
}

export interface AttachmentInfo {
	field: string;
	fileName?: string;
	kind: AttachmentKind;
	mediaType: string;
	bytes: number;
}

// API limits (Messages API): 5 MB per image, 32 MB per PDF request.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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
	if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mediaType: 'application/pdf' };
	if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
		const brand = b.subarray(8, 12).toString('latin1');
		if (/^(heic|heix|hevc|hevx|mif1|msf1|avif)$/.test(brand)) {
			throw new AttachmentError(
				`HEIC/AVIF images (brand "${brand}") are not accepted by Claude. Convert to JPEG first, e.g. with the Edit Image node.`,
			);
		}
	}
	if (declaredMime && TEXT_MIME.test(declaredMime)) return { kind: 'text', mediaType: 'text/plain' };
	throw new AttachmentError(
		`Unsupported attachment type (declared "${declaredMime || 'none'}"). Supported: JPEG, PNG, GIF, WEBP, PDF and plain text.`,
	);
}

export function toContentBlock(buf: Buffer, s: SniffResult, title?: string): Record<string, unknown> {
	if (s.kind === 'image') {
		if (buf.length > MAX_IMAGE_BYTES) {
			throw new AttachmentError(
				`Image is ${(buf.length / 1048576).toFixed(1)} MB; Claude accepts at most 5 MB per image. Resize it first.`,
			);
		}
		return { type: 'image', source: { type: 'base64', media_type: s.mediaType, data: buf.toString('base64') } };
	}
	if (s.kind === 'pdf') {
		if (buf.length > MAX_PDF_BYTES) {
			throw new AttachmentError(`PDF is ${(buf.length / 1048576).toFixed(1)} MB; Claude accepts at most 32 MB.`);
		}
		const block: Record<string, unknown> = {
			type: 'document',
			source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
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
