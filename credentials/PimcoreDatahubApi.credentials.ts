import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class PimcoreDatahubApi implements ICredentialType {
	name = 'pimcoreDatahubApi';

	displayName = 'Pimcore Datahub API';

	documentationUrl = 'https://docs.pimcore.com/platform/Datahub/GraphQL/';

	icon = {
		light: 'file:../nodes/PimcoreDatahub/pimcore.svg',
		dark: 'file:../nodes/PimcoreDatahub/pimcore.dark.svg',
	} as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Pimcore URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://pimcore.example.com',
			description: 'Base URL of the Pimcore instance, without any webservice path',
		},
		{
			// One API key belongs to exactly one Datahub configuration, so the
			// endpoint name is part of the credential rather than of the node.
			displayName: 'Endpoint Name',
			name: 'endpoint',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'my_endpoint',
			description:
				'Name of the Datahub GraphQL configuration, as shown in Pimcore under Datahub > Configurations',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'API key configured in the Security tab of the Datahub configuration',
		},
		{
			displayName: 'Send API Key As',
			name: 'authMethod',
			type: 'options',
			options: [
				{
					name: 'Header',
					value: 'header',
					description: 'Send the key in the X-API-Key header (recommended)',
				},
				{
					name: 'Query Parameter',
					value: 'query',
					description: 'Send the key as ?apikey=, for proxies that strip custom headers',
				},
			],
			default: 'header',
		},
		{
			displayName: 'Ignore SSL Issues',
			name: 'ignoreSslIssues',
			type: 'boolean',
			default: false,
			description: 'Whether to connect even when the certificate cannot be verified',
		},
	];

	/**
	 * Datahub checks the `apikey` header, then `X-API-Key`, then `?apikey=`, and
	 * treats an empty value as absent. That precedence is what lets both slots be
	 * filled unconditionally: in header mode the query parameter arrives empty and
	 * is ignored, in query mode the header arrives empty and Datahub falls through
	 * to the query parameter.
	 */
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.authMethod === "query" ? "" : $credentials.apiKey}}',
			},
			qs: {
				apikey: '={{$credentials.authMethod === "query" ? $credentials.apiKey : ""}}',
			},
		},
	};

	/**
	 * `{ __typename }` is the one query every endpoint answers regardless of its
	 * schema, workspaces or introspection setting, so it tells us the URL, the
	 * endpoint name and the key are all right without touching any data.
	 */
	test: ICredentialTestRequest = {
		request: {
			method: 'POST',
			baseURL:
				'={{$credentials.baseUrl.replace(new RegExp("/+$"), "").replace(new RegExp("/pimcore-graphql-webservices.*$"), "")}}',
			url: '={{"/pimcore-graphql-webservices/" + $credentials.endpoint}}',
			body: { query: '{ __typename }' },
			json: true,
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'errors',
					value: undefined,
					message:
						'The endpoint answered, but rejected the request. Check that the Datahub configuration is active and that the API key belongs to it.',
				},
			},
		],
	};
}
