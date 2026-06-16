import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';

export class ClaudeCliBridge implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Claude CLI Bridge',
		name: 'claudeCliBridge',
		icon: 'fa:robot',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["prompt"].substring(0,50)}}',
		description:
			'Call a locally-installed, authenticated Claude CLI via the claude-cli-bridge HTTP server',
		defaults: { name: 'Claude CLI Bridge' },
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
				description:
					'Optional model id passed as --model. Leave empty for the CLI default (the bridge defaults to Haiku when a PDF is attached and no model is set).',
			},
			{
				displayName: 'Attach PDF',
				name: 'attachPdf',
				type: 'boolean',
				default: false,
				description: 'Whether to attach a PDF from binary input data to the prompt',
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
				description:
					'Request timeout in milliseconds. The bridge itself stops waiting on the CLI after 120s.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('claudeCliBridgeApi');
		const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');

		for (let i = 0; i < items.length; i++) {
			const prompt = this.getNodeParameter('prompt', i) as string;
			const model = this.getNodeParameter('model', i) as string;
			const attachPdf = this.getNodeParameter('attachPdf', i) as boolean;
			const timeout = this.getNodeParameter('timeout', i) as number;

			const body: Record<string, unknown> = { prompt };
			if (model) body.model = model;

			if (attachPdf) {
				const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
				const binaryDataBuffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
				body.pdf_base64 = binaryDataBuffer.toString('base64');
			}

			try {
				const response = await this.helpers.httpRequest({
					method: 'POST',
					url: `${baseUrl}/ask`,
					body,
					json: true,
					timeout,
				});
				returnData.push({ json: response as IDataObject, pairedItem: { item: i } });
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
