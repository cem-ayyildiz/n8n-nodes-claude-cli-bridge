import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ClaudeCliBridgeApi implements ICredentialType {
	name = 'claudeCliBridgeApi';

	displayName = 'Claude CLI';

	documentationUrl = '';

	properties: INodeProperties[] = [
		{
			displayName: 'CLI Path',
			name: 'cliPath',
			type: 'string',
			default: '',
			placeholder: 'claude',
			description:
				'Path to the claude binary, or just "claude" if it is on PATH. Falls back to the CLAUDE_CLI_PATH environment variable, then "claude", if left empty.',
		},
		{
			displayName: 'Home Directory',
			name: 'homeDir',
			type: 'string',
			default: '',
			placeholder: '/home/node',
			description:
				'Directory containing the .claude folder with login credentials (the same one created by `claude login`). Leave empty to use the process HOME. Set this when n8n runs in Docker and you mount the host ~/.claude directory into the container.',
		},
	];
}
