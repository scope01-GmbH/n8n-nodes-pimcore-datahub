import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/** A single entry of the `errors` array a GraphQL response may carry. */
export interface GraphqlError {
	message: string;
	path?: Array<string | number>;
	locations?: Array<{ line: number; column: number }>;
	extensions?: IDataObject;
}

export interface GraphqlResponse<T = IDataObject> {
	data?: T;
	errors?: GraphqlError[];
}

export interface GraphqlRequestBody {
	query: string;
	variables?: IDataObject;
}

/**
 * Normalises a user supplied Pimcore URL into an origin.
 *
 * Accepts `pimcore-x.local`, `http://pimcore-x.local/`, or a URL that already
 * carries the webservice path, and always returns a bare origin without a
 * trailing slash.
 */
export function normalizePimcoreUrl(raw: string): string {
	let url = (raw ?? '').trim();

	if (url === '') {
		throw new Error('Pimcore URL is empty');
	}

	if (!/^https?:\/\//i.test(url)) {
		url = `https://${url}`;
	}

	url = url.replace(/\/+$/, '');
	url = url.replace(/\/pimcore-graphql-webservices(\/.*)?$/i, '');

	return url;
}

/** Builds the webservice URL for a Datahub endpoint configuration. */
export function buildGraphqlUrl(baseUrl: string, endpoint: string): string {
	const name = (endpoint ?? '').trim().replace(/^\/+|\/+$/g, '');

	if (name === '') {
		throw new Error('Datahub endpoint name is empty');
	}

	return `${normalizePimcoreUrl(baseUrl)}/pimcore-graphql-webservices/${encodeURIComponent(name)}`;
}

/** Splits an array into chunks of at most `size` entries. */
export function chunk<T>(input: T[], size: number): T[][] {
	if (size < 1) {
		throw new Error('Batch size must be at least 1');
	}

	const out: T[][] = [];
	for (let i = 0; i < input.length; i += size) {
		out.push(input.slice(i, i + size));
	}

	return out;
}

/**
 * Groups GraphQL errors by the alias they belong to.
 *
 * Datahub answers a batched document with one `errors` array for the whole
 * request; the leading element of each error's `path` is the alias that failed.
 * Errors without a usable path (syntax errors, auth failures, validation of the
 * document itself) land under the empty key and apply to every item.
 */
export function groupErrorsByAlias(errors: GraphqlError[]): Map<string, GraphqlError[]> {
	const grouped = new Map<string, GraphqlError[]>();

	for (const error of errors) {
		const alias = typeof error.path?.[0] === 'string' ? (error.path[0] as string) : '';
		const bucket = grouped.get(alias);

		if (bucket === undefined) {
			grouped.set(alias, [error]);
		} else {
			bucket.push(error);
		}
	}

	return grouped;
}

/** Joins GraphQL error messages into a single human readable line. */
export function formatErrors(errors: GraphqlError[]): string {
	return errors
		.map((error) => {
			const path = error.path?.length ? ` (at ${error.path.join('.')})` : '';
			return `${error.message}${path}`;
		})
		.join('; ');
}

/**
 * Executes a GraphQL document against the configured Datahub endpoint.
 *
 * GraphQL answers failures with `200 OK` and an `errors` array, which an HTTP
 * Request node happily reports as success. Everything that reaches this function
 * therefore inspects `errors` itself: `throwOnError` (the default) raises, while
 * batched callers pass `false` and attribute the errors to individual items.
 */
export async function graphqlRequest<T = IDataObject>(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	body: GraphqlRequestBody,
	throwOnError = true,
): Promise<GraphqlResponse<T>> {
	// Only the URL is assembled here; the API key is attached by the credential's
	// `authenticate` block, which is what httpRequestWithAuthentication applies.
	const credentials = await this.getCredentials('pimcoreDatahubApi');
	const url = buildGraphqlUrl(credentials.baseUrl as string, credentials.endpoint as string);

	const options: IHttpRequestOptions = {
		method: 'POST',
		url,
		body,
		json: true,
		headers: { 'Content-Type': 'application/json' },
		skipSslCertificateValidation: credentials.ignoreSslIssues === true,
	};

	let response: GraphqlResponse<T>;

	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'pimcoreDatahubApi',
			options,
		)) as GraphqlResponse<T>;
	} catch (error) {
		throw enrichTransportError.call(this, error as JsonObject, url);
	}

	if (throwOnError && response?.errors?.length) {
		throw new NodeApiError(this.getNode(), response as unknown as JsonObject, {
			message: 'Pimcore Datahub returned a GraphQL error',
			description: formatErrors(response.errors),
		});
	}

	return response;
}

/**
 * Turns the two transport failures users actually hit into actionable messages.
 *
 * Both arrive as bare HTTP status codes with no GraphQL body, and both are
 * configuration mistakes rather than bugs: the endpoint name and the API key are
 * the only two things a new credential can get wrong.
 */
function enrichTransportError(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	error: JsonObject,
	url: string,
): NodeApiError {
	const status = (error.httpCode ?? (error.response as JsonObject | undefined)?.status) as
		| string
		| number
		| undefined;

	if (String(status) === '404') {
		return new NodeApiError(this.getNode(), error, {
			message: 'Datahub endpoint not found',
			description: `No active Datahub configuration answered at ${url}. Check the endpoint name in the credential, and that the configuration is set to active in Pimcore.`,
		});
	}

	if (String(status) === '403') {
		return new NodeApiError(this.getNode(), error, {
			message: 'Datahub rejected the API key',
			description:
				'The endpoint exists but the API key is not valid for it. Each Datahub configuration carries its own key.',
		});
	}

	return new NodeApiError(this.getNode(), error);
}

/**
 * Reads a JSON node parameter that may arrive as an object or as a string.
 *
 * n8n hands `json` typed parameters over as a string whenever the user typed
 * into the editor, and as a parsed object when an expression produced one.
 */
export function parseJsonParameter(
	value: unknown,
	node: IExecuteFunctions,
	itemIndex: number,
	parameterName: string,
): IDataObject {
	if (value === undefined || value === null || value === '') {
		return {};
	}

	if (typeof value === 'object') {
		return value as IDataObject;
	}

	if (typeof value !== 'string') {
		throw new NodeOperationError(
			node.getNode(),
			`${parameterName} must be an object or a JSON string`,
			{ itemIndex },
		);
	}

	try {
		const parsed = JSON.parse(value) as unknown;

		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error('not an object');
		}

		return parsed as IDataObject;
	} catch {
		throw new NodeOperationError(node.getNode(), `${parameterName} is not valid JSON`, {
			itemIndex,
			description: `Received: ${value.slice(0, 200)}`,
		});
	}
}

/**
 * Coerces an element ID to the integer the mutation arguments expect.
 *
 * Pimcore types `id` as GraphQL `ID`, which serialises to a string, while every
 * mutation takes `Int`. Reading objects and piping them into an update is the
 * most ordinary workflow there is, so without this every such chain fails on
 * `Int cannot represent non-integer value: "5991"`.
 */
export function toElementId(
	value: unknown,
	node: IExecuteFunctions,
	itemIndex: number,
	parameterName: string,
): number {
	if (typeof value === 'number' && Number.isInteger(value)) {
		return value;
	}

	if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
		return Number(value.trim());
	}

	throw new NodeOperationError(node.getNode(), `${parameterName} must be a numeric Pimcore ID`, {
		itemIndex,
		description: `Received: ${JSON.stringify(value)}`,
	});
}

/**
 * Detects a JSON parameter left in fixed mode while containing n8n expressions.
 *
 * n8n only evaluates `{{ ... }}` when the parameter is in expression mode, which
 * it stores with a leading `=`. Without it the placeholders travel to Pimcore as
 * literal text and get written into the object verbatim.
 */
export function hasUnresolvedExpression(rawParameter: unknown): boolean {
	if (typeof rawParameter !== 'string') return false;
	if (rawParameter.startsWith('=')) return false;

	return /\{\{\s*\$/.test(rawParameter);
}
