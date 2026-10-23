import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ClaudeCliBridgeApi implements ICredentialType {
	name = 'claudeCliBridgeApi';

	displayName = 'Claude CLI';

	documentationUrl = 'https://github.com/cem-ayyildiz/n8n-nodes-claude-cli-bridge#credential-claude-cli';

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
		{
			displayName: 'Config Directory',
			name: 'configDir',
			type: 'string',
			default: '',
			placeholder: '/home/node/.claude',
			description:
				'Optional CLAUDE_CONFIG_DIR for the CLI. Leave empty to use <Home Directory>/.claude.',
		},
		{
			displayName: 'OAuth Token',
			name: 'oauthToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Optional long-lived token from `claude setup-token`, passed as CLAUDE_CODE_OAUTH_TOKEN. Leave empty to use the login stored in the config directory, or a CLAUDE_CODE_OAUTH_TOKEN already set on the n8n process.',
		},
	];
}
