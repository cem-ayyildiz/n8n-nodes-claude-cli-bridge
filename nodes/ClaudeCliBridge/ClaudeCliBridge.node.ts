import { execFile, ExecFileException } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';

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

export class ClaudeCliBridge implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Claude CLI',
		name: 'claudeCliBridge',
		icon: 'fa:robot',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["prompt"].substring(0,50)}}',
		description:
			'Call the locally-installed, subscription-authenticated Claude CLI directly (no Anthropic API key)',
		defaults: { name: 'Claude CLI' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
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
				description: 'The text passed to `claude -p`',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: '',
				placeholder: 'claude-sonnet-4-6',
				description: 'Optional model id passed as --model. Leave empty for the CLI default.',
			},
			{
				displayName: 'Attach PDF',
				name: 'attachPdf',
				type: 'boolean',
				default: false,
				description:
					'Whether to extract text from a PDF in binary input data (via pdftotext) and append it to the prompt',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: { show: { attachPdf: [true] } },
				description: 'Name of the binary property containing the PDF file',
			},
			{
				displayName: 'Timeout (ms)',
				name: 'timeout',
				type: 'number',
				default: 120000,
				description: 'Kill the claude process if it has not finished within this time',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('claudeCliBridgeApi');
		const cliPath = (credentials.cliPath as string) || process.env.CLAUDE_CLI_PATH || 'claude';
		const homeDir = (credentials.homeDir as string) || process.env.HOME;

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
				const { stdout, stderr } = await runClaude(cliPath, args, {
					timeout,
					env: { ...process.env, HOME: homeDir },
				});
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
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
