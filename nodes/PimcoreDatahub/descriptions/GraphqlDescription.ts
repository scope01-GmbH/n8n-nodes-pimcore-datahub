import type { INodeProperties } from 'n8n-workflow';

const showForGraphql = { resource: ['graphql'] };

export const graphqlOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: showForGraphql },
		options: [
			{
				name: 'Execute',
				value: 'execute',
				description: 'Run a GraphQL document against the endpoint',
				action: 'Execute a custom document',
			},
		],
		default: 'execute',
	},
];

export const graphqlFields: INodeProperties[] = [
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		typeOptions: { rows: 10 },
		default: '',
		required: true,
		displayOptions: { show: showForGraphql },
		placeholder: 'query { getProductListing(first: 10) { edges { node { key } } } }',
		description:
			'The GraphQL query or mutation. Use this for anything the other operations do not cover: custom queries, document reads, field collections and object bricks.',
	},
	{
		displayName: 'Variables',
		name: 'variables',
		type: 'json',
		default: '{}',
		displayOptions: { show: showForGraphql },
		description: 'Variables for the document, as JSON',
	},
];
