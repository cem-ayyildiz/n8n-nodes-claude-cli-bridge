// Runs the compiled node outside n8n, against the real `claude` CLI on this
// machine, with a minimal stand-in for IExecuteFunctions. Build first
// (`npm run build`). Usage from a test script:
//
//   const { run } = require('./harness');
//   const out = await run({ typeVersion: 2, params: {...}, items: [{ json: {}, binary: { data: { path, mimeType } } }] });
//
// Binary entries take a `path` to a local file; the harness loads it the way
// n8n's getBinaryDataBuffer would.
const fs = require('fs');
const path = require('path');
const { ClaudeCliBridge } = require('../dist/nodes/ClaudeCliBridge/ClaudeCliBridge.node.js');

async function run({ typeVersion = 2, params = {}, items = [{ json: {} }], credentials = {}, continueOnFail = false }) {
	const node = new ClaudeCliBridge();
	const loaded = items.map((it) => {
		const binary = {};
		for (const [k, v] of Object.entries(it.binary || {})) {
			binary[k] = { mimeType: v.mimeType || 'application/octet-stream', fileName: v.fileName || path.basename(v.path), _path: v.path };
		}
		return { json: it.json || {}, binary: Object.keys(binary).length ? binary : undefined };
	});
	const ctx = {
		getNode: () => ({ name: 'Claude CLI', typeVersion, type: 'claudeCliBridge' }),
		getInputData: () => loaded,
		getCredentials: async () => ({ cliPath: '', homeDir: '', configDir: '', oauthToken: '', ...credentials }),
		getNodeParameter: (name, i, fallback) => (name in params ? params[name] : fallback),
		continueOnFail: () => continueOnFail,
		getExecutionCancelSignal: () => undefined,
		helpers: {
			getBinaryDataBuffer: async (i, field) => fs.readFileSync(loaded[i].binary[field]._path),
		},
	};
	const out = await node.execute.call(ctx);
	return out[0].map((o) => o.json);
}

module.exports = { run };
