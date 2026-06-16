import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ClaudeCliBridgeApi implements ICredentialType {
	name = 'claudeCliBridgeApi';

	displayName = 'Claude CLI Bridge API';

	documentationUrl = '';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:3456',
			description:
				'Address of the claude-cli-bridge server. Use http://host.docker.internal:3456 when n8n runs in Docker and the bridge runs on the host.',
		},
	];
}
