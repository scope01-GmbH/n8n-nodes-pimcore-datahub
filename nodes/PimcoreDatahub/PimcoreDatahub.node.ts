import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ResourceMapperFields,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	chunk,
	formatErrors,
	graphqlRequest,
	groupErrorsByAlias,
	hasUnresolvedExpression,
	parseJsonParameter,
	toElementId,
	type GraphqlError,
} from './GenericFunctions';
import { fetchSchema, type SchemaIndex } from './Introspection';
import { inputTypeName, resourceMapperFields, writableFields } from './WriteSchema';
import {
	buildDocument,
	buildSelectionSet,
	listFieldPaths,
	SYSTEM_METADATA_FIELDS,
	type AliasedOperation,
	type GraphqlArg,
} from './QueryBuilder';
import { assetFields, assetOperations } from './descriptions/AssetDescription';
import { dataObjectFields, dataObjectOperations } from './descriptions/DataObjectDescription';
import { graphqlFields, graphqlOperations } from './descriptions/GraphqlDescription';

/** Identity of an object resolved by the upsert lookup. */
interface MatchResult {
	itemIndex: number;
	objectId?: number;
	fullpath?: string;
	found: boolean;
	/** Set when the item cannot proceed, e.g. an ambiguous match. */
	failure?: string;
}

export class PimcoreDatahub implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Pimcore Datahub',
		name: 'pimcoreDatahub',
		icon: { light: 'file:pimcore.svg', dark: 'file:pimcore.dark.svg' },
		group: ['transform'],
		version: [2],
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Read and write Pimcore data objects through a Datahub GraphQL endpoint',
		defaults: { name: 'Pimcore Datahub' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'pimcoreDatahubApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Asset', value: 'asset' },
					{ name: 'Data Object', value: 'dataObject' },
					{ name: 'GraphQL', value: 'graphql' },
				],
				default: 'dataObject',
			},
			...dataObjectOperations,
			...dataObjectFields,
			...assetOperations,
			...assetFields,
			...graphqlOperations,
			...graphqlFields,
		],
	};

	methods = {
		listSearch: {
			/**
			 * Classes the endpoint exposes, read from its own query schema.
			 *
			 * The query type is the authority rather than Pimcore's class list: a
			 * class can exist without being published to this endpoint, and offering
			 * one that is not would produce a query the server rejects.
			 */
			async searchClasses(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const schema = await fetchSchema.call(this);
				const needle = (filter ?? '').toLowerCase();

				return {
					results: schema.readableClasses
						.filter((name) => needle === '' || name.toLowerCase().includes(needle))
						.map((name) => ({ name, value: name })),
				};
			},
		},

		loadOptions: {
			/** Selectable field paths for the chosen class. */
			async getFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const className = currentClassName.call(this);

				if (!className) return [];

				const schema = await fetchSchema.call(this);

				return listFieldPaths(schema, `object_${className}`).map((option) => ({
					name: option.name,
					value: option.value,
					description: option.description,
				}));
			},

			/** Selectable field paths on the asset type. */
			async getAssetFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const schema = await fetchSchema.call(this);

				return listFieldPaths(schema, 'asset').map((option) => ({
					name: option.name,
					value: option.value,
					description: option.description,
				}));
			},
		},

		resourceMapping: {
			/** Writable fields of the chosen class, for the Fields to Write mapper. */
			async getWritableFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const className = currentClassName.call(this);

				if (!className) {
					return {
						fields: [],
						emptyFieldsNotice: 'Choose a class first to load its writable fields.',
					};
				}

				const schema = await fetchSchema.call(this);

				return resourceMapperFields(schema, className);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		if (resource === 'graphql') {
			return [await executeRawGraphql.call(this, items)];
		}

		if (resource === 'asset') {
			switch (operation) {
				case 'getAsset':
					return [await executeAssetGet.call(this, items)];
				case 'getAllAssets':
					return [await executeAssetGetAll.call(this, items)];
				case 'uploadAsset':
				case 'updateAsset':
				case 'deleteAsset':
					return [await executeAssetWrite.call(this, items, operation)];
				default:
					throw new NodeOperationError(this.getNode(), `Unknown asset operation: ${operation}`);
			}
		}

		switch (operation) {
			case 'get':
				return [await executeGet.call(this, items)];
			case 'getAll':
				return [await executeGetAll.call(this, items)];
			case 'create':
			case 'update':
			case 'delete':
				return [await executeWrite.call(this, items, operation)];
			case 'createOrUpdate':
				return [await executeUpsert.call(this, items)];
			default:
				throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
		}
	}
}

// ---------------------------------------------------------------- shared

/**
 * Reads the class out of the resource locator, in either mode.
 *
 * `extractValue` unwraps a locator to its plain value, so From List and By Name
 * both arrive here as a bare class name.
 */
function resolveClassName(this: IExecuteFunctions, itemIndex: number): string {
	const value = this.getNodeParameter('className', itemIndex, '', {
		extractValue: true,
	}) as string;

	const className = (value ?? '').trim();

	if (className === '') {
		throw new NodeOperationError(this.getNode(), 'No Pimcore class selected', { itemIndex });
	}

	return className;
}

/** The same, for the editor context that populates the field dropdown. */
function currentClassName(this: ILoadOptionsFunctions): string {
	const raw = this.getCurrentNodeParameter('className') as
		| string
		| { value?: string }
		| undefined;

	if (typeof raw === 'string') return raw.trim();

	return (raw?.value ?? '').trim();
}

/**
 * Loads the endpoint schema, unless every selection in play is raw.
 *
 * Endpoints with introspection disabled cannot answer, and asking anyway turns
 * a working raw-mode workflow into a hard failure.
 */
async function schemaFor(this: IExecuteFunctions, needed: boolean): Promise<SchemaIndex | null> {
	if (!needed) return null;

	return await fetchSchema.call(this as unknown as ILoadOptionsFunctions);
}

function readOptions(this: IExecuteFunctions, itemIndex: number): IDataObject {
	return this.getNodeParameter('options', itemIndex, {}) as IDataObject;
}

/** Reads one entry out of the operation's Additional Fields collection. */
function additionalField<T>(
	this: IExecuteFunctions,
	name: string,
	itemIndex: number,
	fallback: T,
): T {
	const bag = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;

	return (bag[name] === undefined ? fallback : bag[name]) as T;
}

/**
 * Field values for a write, from whichever input mode the node is in.
 *
 * Raw JSON stays a first class mode rather than a fallback: an endpoint with
 * introspection disabled gives the mapper no field list to work from, and that
 * is a supported way to run Datahub.
 */
async function writeInput(
	this: IExecuteFunctions,
	itemIndex: number,
	className: string,
): Promise<IDataObject> {
	const mode = this.getNodeParameter('inputMode', itemIndex, 'mapped') as 'mapped' | 'json';

	if (mode === 'json') {
		if (hasUnresolvedExpression(this.getNode().parameters.input)) {
			throw new NodeOperationError(this.getNode(), 'Input contains an unevaluated expression', {
				itemIndex,
				description:
					'The Input field holds {{ ... }} placeholders but is in fixed mode, so they would be written to Pimcore verbatim. Switch the field to expression mode.',
			});
		}

		return parseJsonParameter(
			this.getNodeParameter('input', itemIndex, {}),
			this,
			itemIndex,
			'Input',
		);
	}

	const mapper = this.getNodeParameter('fieldsToWrite', itemIndex, {}) as {
		mappingMode?: string;
		value?: IDataObject | null;
	};

	if (mapper.mappingMode !== 'autoMapInputData') {
		return mapper.value ?? {};
	}

	// Auto-map takes the item as it arrives, so it has to be narrowed to what the
	// class accepts: an item that came out of a Get carries id, fullpath and the
	// rest of the read-only metadata, and GraphQL rejects the entire mutation on
	// the first field the input type does not define.
	const schema = await fetchSchema.call(this as unknown as ILoadOptionsFunctions);
	const writable = new Set(writableFields(schema, className).map((field) => field.name));
	const item = this.getInputData()[itemIndex]?.json ?? {};

	return Object.fromEntries(Object.entries(item).filter(([name]) => writable.has(name)));
}

/** Selection set for read operations, honouring the Fields parameter. */
function readSelection(
	this: IExecuteFunctions,
	schema: SchemaIndex | null,
	className: string,
	itemIndex: number,
): string {
	const mode = this.getNodeParameter('fieldSelection', itemIndex, 'auto') as
		| 'auto'
		| 'selected'
		| 'raw';
	const options = readOptions.call(this, itemIndex);

	return buildSelectionSet(schema, `object_${className}`, {
		mode,
		fields: this.getNodeParameter('fields', itemIndex, []) as string[],
		raw: this.getNodeParameter('rawSelection', itemIndex, '') as string,
		maxDepth: (options.maxDepth as number) ?? 1,
	});
}

/**
 * Selection set for the `output` of a mutation.
 *
 * Kept to scalars on purpose - see SelectionOptions.scalarsOnly - and kept small
 * by default, because an import writing thousands of objects does not want the
 * whole record echoed back. The identity fields are always there so the workflow
 * can pick up the ID of something it just created.
 */
function writeSelection(
	schema: SchemaIndex | null,
	className: string,
	returnWrittenObject: boolean,
): string {
	if (!returnWrittenObject || schema === null) {
		return '    id\n    fullpath\n    key\n    published';
	}

	const body = buildSelectionSet(schema, `object_${className}`, {
		mode: 'auto',
		scalarsOnly: true,
		excludeFields: SYSTEM_METADATA_FIELDS,
	});

	return body
		.split('\n')
		.map((line) => `  ${line}`)
		.join('\n');
}

function toItem(json: IDataObject, itemIndex: number): INodeExecutionData {
	return { json, pairedItem: { item: itemIndex } };
}

/** Applies Continue On Fail, or throws with the item index attached. */
function failItem(
	this: IExecuteFunctions,
	output: INodeExecutionData[],
	itemIndex: number,
	message: string,
	description?: string,
): void {
	if (!this.continueOnFail()) {
		throw new NodeOperationError(this.getNode(), message, {
			itemIndex,
			description,
		});
	}

	output.push({
		json: description ? { error: message, description } : { error: message },
		pairedItem: { item: itemIndex },
	});
}

/**
 * failItem for a caught error, keeping any description it carries.
 *
 * `graphqlRequest` puts the formatted GraphQL errors on NodeApiError.description.
 * Reading only `.message` off the caught error throws that away and leaves the
 * user with "Pimcore Datahub returned a GraphQL error" and nothing else.
 */
function failItemFromError(
	this: IExecuteFunctions,
	output: INodeExecutionData[],
	itemIndex: number,
	error: unknown,
): void {
	const message = error instanceof Error ? error.message : String(error);
	const description = (error as { description?: unknown }).description;

	failItem.call(
		this,
		output,
		itemIndex,
		message,
		typeof description === 'string' && description !== '' ? description : undefined,
	);
}

// ---------------------------------------------------------------- raw

async function executeRawGraphql(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const query = this.getNodeParameter('query', itemIndex) as string;
			const variables = parseJsonParameter(
				this.getNodeParameter('variables', itemIndex, {}),
				this,
				itemIndex,
				'Variables',
			);

			const response = await graphqlRequest.call(this, { query, variables });

			output.push(toItem((response.data ?? {}) as IDataObject, itemIndex));
		} catch (error) {
			failItemFromError.call(this, output, itemIndex, error);
		}
	}

	return output;
}

// ---------------------------------------------------------------- get

/**
 * Reads one object per input item, batching the reads into one document.
 *
 * Fetching 200 objects by ID is 200 GraphQL fields, not 200 requests.
 */
async function executeGet(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];
	const className = resolveClassName.call(this, 0);
	const mode = this.getNodeParameter('fieldSelection', 0, 'auto') as string;
	const schema = await schemaFor.call(this, mode !== 'raw');
	const batchSize = (readOptions.call(this, 0).batchSize as number) ?? 25;

	const indexes = items.map((_item, index) => index);

	for (const batch of chunk(indexes, batchSize)) {
		const operations: AliasedOperation[] = [];
		const aliasToItem = new Map<string, number>();

		for (const itemIndex of batch) {
			const alias = `op${itemIndex}`;
			const lookupBy = this.getNodeParameter('lookupBy', itemIndex, 'id') as string;
			const options = readOptions.call(this, itemIndex);

			const args: GraphqlArg[] =
				lookupBy === 'id'
					? [
							{
								arg: 'id',
								type: 'Int',
								value: toElementId(
									this.getNodeParameter('objectId', itemIndex),
									this,
									itemIndex,
									'Object ID',
								),
							},
						]
					: [
							{
								arg: 'fullpath',
								type: 'String',
								value: this.getNodeParameter('fullpath', itemIndex),
							},
						];

			if (options.defaultLanguage) {
				args.push({
					arg: 'defaultLanguage',
					type: 'String',
					value: options.defaultLanguage,
				});
			}

			operations.push({
				alias,
				field: `get${className}`,
				args,
				selection: readSelection.call(this, schema, className, itemIndex),
			});
			aliasToItem.set(alias, itemIndex);
		}

		const document = buildDocument('query', operations);
		const response = await graphqlRequest.call(this, document, false);
		const errorsByAlias = groupErrorsByAlias(response.errors ?? []);

		throwOnGlobalErrors.call(this, errorsByAlias);

		for (const [alias, itemIndex] of aliasToItem) {
			const aliasErrors = errorsByAlias.get(alias);

			if (aliasErrors?.length) {
				failItem.call(this, output, itemIndex, formatErrors(aliasErrors));
				continue;
			}

			const node = (response.data as IDataObject | undefined)?.[alias] as IDataObject | null;

			if (node === null || node === undefined) {
				failItem.call(this, output, itemIndex, 'Object not found');
				continue;
			}

			output.push(toItem(node, itemIndex));
		}
	}

	return output;
}

// ---------------------------------------------------------------- get many

async function executeGetAll(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];
	const className = resolveClassName.call(this, 0);
	const mode = this.getNodeParameter('fieldSelection', 0, 'auto') as string;
	const schema = await schemaFor.call(this, mode !== 'raw');

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
			const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
			const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
			const options = readOptions.call(this, itemIndex);
			const pageSize = (options.pageSize as number) ?? 50;
			const selection = readSelection.call(this, schema, className, itemIndex);

			const baseArgs: GraphqlArg[] = [];

			if (filters.filter) {
				const filter =
					typeof filters.filter === 'string' ? filters.filter : JSON.stringify(filters.filter);
				baseArgs.push({ arg: 'filter', type: 'String', value: filter });
			}
			for (const key of ['ids', 'fullpaths', 'tags'] as const) {
				if (filters[key]) {
					baseArgs.push({ arg: key, type: 'String', value: filters[key] });
				}
			}
			if (filters.sortBy) {
				baseArgs.push({
					arg: 'sortBy',
					type: '[String]',
					value: String(filters.sortBy)
						.split(',')
						.map((entry) => entry.trim()),
				});
			}
			if (filters.sortOrder) {
				baseArgs.push({
					arg: 'sortOrder',
					type: '[String]',
					value: String(filters.sortOrder)
						.split(',')
						.map((entry) => entry.trim()),
				});
			}
			if (filters.published !== undefined) {
				baseArgs.push({
					arg: 'published',
					type: 'Boolean',
					value: filters.published,
				});
			}
			if (options.defaultLanguage) {
				baseArgs.push({
					arg: 'defaultLanguage',
					type: 'String',
					value: options.defaultLanguage,
				});
			}

			let offset = 0;
			let collected = 0;
			let totalCount = Number.POSITIVE_INFINITY;

			while (collected < (returnAll ? totalCount : limit)) {
				const wanted = returnAll ? pageSize : Math.min(pageSize, limit - collected);

				const document = buildDocument('query', [
					{
						alias: 'listing',
						field: `get${className}Listing`,
						args: [
							...baseArgs,
							{ arg: 'first', type: 'Int', value: wanted },
							{ arg: 'after', type: 'Int', value: offset },
						],
						selection: `    totalCount\n    edges {\n      node {\n${selection}\n      }\n    }`,
					},
				]);

				const response = await graphqlRequest.call(this, document);
				const listing = (response.data as IDataObject | undefined)?.listing as
					| { totalCount?: number; edges?: Array<{ node: IDataObject }> }
					| undefined;

				const edges = listing?.edges ?? [];
				totalCount = listing?.totalCount ?? 0;

				for (const edge of edges) {
					output.push(toItem(edge.node, itemIndex));
				}

				collected += edges.length;
				offset += edges.length;

				// A short page means the listing is exhausted, whatever totalCount says.
				if (edges.length === 0 || edges.length < wanted) break;
			}
		} catch (error) {
			failItemFromError.call(this, output, itemIndex, error);
		}
	}

	return output;
}

// ---------------------------------------------------------------- writes

/**
 * Raises errors that belong to the whole document rather than one alias.
 *
 * A syntax error, an unknown mutation or a rejected key fails every item in the
 * batch, so it is reported as a node failure instead of being smeared across
 * items that never had a chance to run.
 */
function throwOnGlobalErrors(
	this: IExecuteFunctions,
	errorsByAlias: Map<string, GraphqlError[]>,
): void {
	const global = errorsByAlias.get('');

	if (global?.length) {
		throw new NodeOperationError(this.getNode(), 'Pimcore Datahub rejected the request', {
			description: formatErrors(global),
		});
	}
}

/** Shared argument assembly for create and update mutations. */
async function mutationArgs(
	this: IExecuteFunctions,
	itemIndex: number,
	className: string,
	kind: 'create' | 'update',
	identity: { objectId?: number; fullpath?: string; key?: string },
): Promise<GraphqlArg[]> {
	const options = readOptions.call(this, itemIndex);
	const args: GraphqlArg[] = [];

	if (kind === 'create') {
		args.push({ arg: 'key', type: 'String!', value: identity.key });

		const parentBy = this.getNodeParameter('parentBy', itemIndex, 'path') as string;
		if (parentBy === 'path') {
			args.push({
				arg: 'path',
				type: 'String',
				value: this.getNodeParameter('parentPath', itemIndex),
			});
		} else {
			args.push({
				arg: 'parentId',
				type: 'Int',
				value: toElementId(
					this.getNodeParameter('parentId', itemIndex),
					this,
					itemIndex,
					'Parent ID',
				),
			});
		}

		args.push({
			arg: 'published',
			type: 'Boolean',
			value: additionalField.call(this, 'published', itemIndex, true),
		});
	} else {
		if (identity.objectId !== undefined) {
			args.push({ arg: 'id', type: 'Int', value: identity.objectId });
		} else {
			args.push({ arg: 'fullpath', type: 'String', value: identity.fullpath });
		}

		if (options.omitVersionCreate) {
			args.push({ arg: 'omitVersionCreate', type: 'Boolean', value: true });
		}
	}

	if (options.defaultLanguage) {
		args.push({
			arg: 'defaultLanguage',
			type: 'String',
			value: options.defaultLanguage,
		});
	}
	if (options.omitMandatoryCheck) {
		args.push({ arg: 'omitMandatoryCheck', type: 'Boolean', value: true });
	}

	args.push({
		arg: 'input',
		type: inputTypeName(className),
		value: await writeInput.call(this, itemIndex, className),
	});

	return args;
}

/** Runs create, update or delete over the input items, in batches. */
async function executeWrite(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
	operation: 'create' | 'update' | 'delete',
): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];
	const className = resolveClassName.call(this, 0);
	const options = readOptions.call(this, 0);
	const batchSize = (options.batchSize as number) ?? 25;
	const schema = await schemaFor.call(this, options.returnWrittenObject === true);
	const selection =
		operation === 'delete'
			? '    success\n    message'
			: `    success\n    message\n    output {\n${writeSelection(schema, className, options.returnWrittenObject === true)}\n    }`;

	const indexes = items.map((_item, index) => index);

	for (const batch of chunk(indexes, batchSize)) {
		const operations: AliasedOperation[] = [];
		const aliasToItem = new Map<string, number>();

		for (const itemIndex of batch) {
			try {
				const alias = `op${itemIndex}`;
				let args: GraphqlArg[];

				if (operation === 'delete') {
					const lookupBy = this.getNodeParameter('lookupBy', itemIndex, 'id') as string;
					args =
						lookupBy === 'id'
							? [
									{
										arg: 'id',
										type: 'Int',
										value: toElementId(
											this.getNodeParameter('objectId', itemIndex),
											this,
											itemIndex,
											'Object ID',
										),
									},
								]
							: [
									{
										arg: 'fullpath',
										type: 'String',
										value: this.getNodeParameter('fullpath', itemIndex),
									},
								];
				} else if (operation === 'create') {
					args = await mutationArgs.call(this, itemIndex, className, 'create', {
						key: this.getNodeParameter('key', itemIndex) as string,
					});
				} else {
					const lookupBy = this.getNodeParameter('lookupBy', itemIndex, 'id') as string;
					args = await mutationArgs.call(this, itemIndex, className, 'update', {
						objectId:
							lookupBy === 'id'
								? toElementId(
										this.getNodeParameter('objectId', itemIndex),
										this,
										itemIndex,
										'Object ID',
									)
								: undefined,
						fullpath:
							lookupBy === 'fullpath'
								? (this.getNodeParameter('fullpath', itemIndex) as string)
								: undefined,
					});
				}

				operations.push({
					alias,
					field: `${operation}${className}`,
					args,
					selection,
				});
				aliasToItem.set(alias, itemIndex);
			} catch (error) {
				failItemFromError.call(this, output, itemIndex, error);
			}
		}

		if (operations.length === 0) continue;

		await runMutationBatch.call(this, operations, aliasToItem, output);
	}

	return output;
}

/**
 * Sends one batched mutation document and maps its results back to items.
 *
 * Two kinds of failure arrive here. GraphQL errors carry the alias in their
 * `path`; Pimcore's own validation failures arrive as `success: false` with a
 * message inside otherwise-valid data. Both end up on the item that caused them.
 */
async function runMutationBatch(
	this: IExecuteFunctions,
	operations: AliasedOperation[],
	aliasToItem: Map<string, number>,
	output: INodeExecutionData[],
	resultKey: 'output' | 'assetData' = 'output',
): Promise<void> {
	const document = buildDocument('mutation', operations);
	const response = await graphqlRequest.call(this, document, false);
	const errorsByAlias = groupErrorsByAlias(response.errors ?? []);

	throwOnGlobalErrors.call(this, errorsByAlias);

	for (const [alias, itemIndex] of aliasToItem) {
		const aliasErrors = errorsByAlias.get(alias) ?? [];

		// Errors under `<alias>.<resultKey>` are the echoed-back object failing to
		// resolve, not the write failing. Pimcore commits before it resolves the
		// output selection, so failing the item here would report a write that
		// actually happened as an error - and invite a duplicate on the next run.
		const selectionErrors = aliasErrors.filter((error) => error.path?.[1] === resultKey);
		const mutationErrors = aliasErrors.filter((error) => error.path?.[1] !== resultKey);

		if (mutationErrors.length) {
			failItem.call(this, output, itemIndex, formatErrors(mutationErrors));
			continue;
		}

		const result = (response.data as IDataObject | undefined)?.[alias] as
			| ({ success?: boolean; message?: string } & Record<string, unknown>)
			| undefined;

		if (result?.success !== true) {
			failItem.call(
				this,
				output,
				itemIndex,
				result?.message ?? 'Pimcore reported no result for this item',
			);
			continue;
		}

		output.push(
			toItem(
				{
					success: true,
					message: result.message,
					...((result[resultKey] as IDataObject | undefined) ?? {}),
					...(selectionErrors.length
						? {
								warning: `The write succeeded, but the endpoint could not return part of the object: ${formatErrors(
									selectionErrors,
								)}`,
							}
						: {}),
				},
				itemIndex,
			),
		);
	}
}

// ---------------------------------------------------------------- upsert

/**
 * Create or update, the shape most integrations actually need.
 *
 * Datahub has no upsert, so identity is resolved first: one batched lookup
 * document for the whole batch, then one batched mutation document mixing
 * creates and updates. Two round trips per batch, not two per item.
 */
async function executeUpsert(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];
	const className = resolveClassName.call(this, 0);
	const options = readOptions.call(this, 0);
	const batchSize = (options.batchSize as number) ?? 25;
	const schema = await schemaFor.call(this, options.returnWrittenObject === true);
	const selection = `    success\n    message\n    output {\n${writeSelection(schema, className, options.returnWrittenObject === true)}\n    }`;

	const indexes = items.map((_item, index) => index);

	for (const batch of chunk(indexes, batchSize)) {
		const matches = await resolveMatches.call(this, batch, className);

		const operations: AliasedOperation[] = [];
		const aliasToItem = new Map<string, number>();

		for (const match of matches) {
			const itemIndex = match.itemIndex;

			try {
				if (match.failure) {
					failItem.call(this, output, itemIndex, match.failure);
					continue;
				}

				const alias = `op${itemIndex}`;

				if (match.found) {
					operations.push({
						alias,
						field: `update${className}`,
						args: await mutationArgs.call(this, itemIndex, className, 'update', {
							objectId: match.objectId,
							fullpath: match.objectId === undefined ? match.fullpath : undefined,
						}),
						selection,
					});
					aliasToItem.set(alias, itemIndex);
					continue;
				}

				const ifNotFound = this.getNodeParameter('ifNotFound', itemIndex, 'create') as string;

				if (ifNotFound === 'skip') {
					output.push(toItem({ ...items[itemIndex].json, skipped: true }, itemIndex));
					continue;
				}

				if (ifNotFound === 'error') {
					failItem.call(this, output, itemIndex, 'No matching object found');
					continue;
				}

				operations.push({
					alias,
					field: `create${className}`,
					args: await mutationArgs.call(this, itemIndex, className, 'create', {
						key: upsertKey.call(this, itemIndex),
					}),
					selection,
				});
				aliasToItem.set(alias, itemIndex);
			} catch (error) {
				failItemFromError.call(this, output, itemIndex, error);
			}
		}

		if (operations.length === 0) continue;

		await runMutationBatch.call(this, operations, aliasToItem, output);
	}

	return output;
}

/** The key a newly created object gets, defaulting to the match value. */
function upsertKey(this: IExecuteFunctions, itemIndex: number): string {
	const explicit = (additionalField<string>).call(this, 'key', itemIndex, '').trim();
	if (explicit !== '') return explicit;

	const matchBy = this.getNodeParameter('matchBy', itemIndex, 'field') as string;

	if (matchBy === 'field') {
		const value = String(this.getNodeParameter('matchValue', itemIndex, '')).trim();
		if (value !== '') return value;
	}

	if (matchBy === 'fullpath') {
		const fullpath = String(this.getNodeParameter('fullpath', itemIndex, ''));
		const last = fullpath.split('/').filter(Boolean).pop();
		if (last) return last;
	}

	throw new NodeOperationError(
		this.getNode(),
		'Cannot derive a key for the new object. Set Key explicitly.',
		{ itemIndex },
	);
}

/**
 * Resolves each item in the batch to an existing object, in one request.
 *
 * Field matching asks for two results rather than one: a filter that hits
 * several objects is a data problem, and picking an arbitrary one of them would
 * quietly corrupt the wrong record.
 */
async function resolveMatches(
	this: IExecuteFunctions,
	batch: number[],
	className: string,
): Promise<MatchResult[]> {
	const operations: AliasedOperation[] = [];
	const aliasToItem = new Map<string, number>();
	const results: MatchResult[] = [];
	const byField = new Set<string>();

	for (const itemIndex of batch) {
		const alias = `m${itemIndex}`;
		const matchBy = this.getNodeParameter('matchBy', itemIndex, 'field') as string;

		if (matchBy === 'field') {
			const field = this.getNodeParameter('matchField', itemIndex) as string;
			const value = this.getNodeParameter('matchValue', itemIndex) as string;

			operations.push({
				alias,
				field: `get${className}Listing`,
				args: [
					{
						// Datahub's filter grammar has no equality operator: a bare value
						// means equals. An unrecognised `$op` key is read as a column
						// name instead, which surfaces as an opaque SQL error rather
						// than a GraphQL one.
						arg: 'filter',
						type: 'String',
						value: JSON.stringify({ [field]: value }),
					},
					{ arg: 'first', type: 'Int', value: 2 },
				],
				selection:
					'    totalCount\n    edges {\n      node {\n        id\n        fullpath\n      }\n    }',
			});
			byField.add(alias);
		} else {
			const args: GraphqlArg[] =
				matchBy === 'id'
					? [
							{
								arg: 'id',
								type: 'Int',
								value: toElementId(
									this.getNodeParameter('objectId', itemIndex),
									this,
									itemIndex,
									'Object ID',
								),
							},
						]
					: [
							{
								arg: 'fullpath',
								type: 'String',
								value: this.getNodeParameter('fullpath', itemIndex),
							},
						];

			operations.push({
				alias,
				field: `get${className}`,
				args,
				selection: '    id\n    fullpath',
			});
		}

		aliasToItem.set(alias, itemIndex);
	}

	const document = buildDocument('query', operations);
	const response = await graphqlRequest.call(this, document, false);
	const errorsByAlias = groupErrorsByAlias(response.errors ?? []);

	throwOnGlobalErrors.call(this, errorsByAlias);

	for (const [alias, itemIndex] of aliasToItem) {
		const aliasErrors = errorsByAlias.get(alias);

		if (aliasErrors?.length) {
			results.push({
				itemIndex,
				found: false,
				failure: formatErrors(aliasErrors),
			});
			continue;
		}

		const payload = (response.data as IDataObject | undefined)?.[alias];

		if (byField.has(alias)) {
			const listing = payload as {
				totalCount?: number;
				edges?: Array<{ node: IDataObject }>;
			} | null;
			const edges = listing?.edges ?? [];

			if ((listing?.totalCount ?? 0) > 1) {
				results.push({
					itemIndex,
					found: false,
					failure: `Match is ambiguous: ${listing?.totalCount} objects match. Matched IDs: ${edges
						.map((edge) => edge.node.id)
						.join(', ')}.`,
				});
				continue;
			}

			if (edges.length === 0) {
				results.push({ itemIndex, found: false });
				continue;
			}

			results.push({
				itemIndex,
				found: true,
				objectId: Number(edges[0].node.id),
				fullpath: edges[0].node.fullpath as string,
			});
			continue;
		}

		const node = payload as IDataObject | null;

		if (node === null || node === undefined) {
			results.push({ itemIndex, found: false });
			continue;
		}

		results.push({
			itemIndex,
			found: true,
			objectId: Number(node.id),
			fullpath: node.fullpath as string,
		});
	}

	return results;
}

// ---------------------------------------------------------------- assets

/** Options collection for the asset resource. */
function assetOptions(this: IExecuteFunctions, itemIndex: number): IDataObject {
	return this.getNodeParameter('assetOptions', itemIndex, {}) as IDataObject;
}

/** Identity arguments for an asset addressed by ID or full path. */
function assetIdentityArgs(this: IExecuteFunctions, itemIndex: number): GraphqlArg[] {
	const lookupBy = this.getNodeParameter('assetLookupBy', itemIndex, 'id') as string;

	if (lookupBy === 'id') {
		return [
			{
				arg: 'id',
				type: 'Int',
				value: toElementId(
					this.getNodeParameter('assetId', itemIndex),
					this,
					itemIndex,
					'Asset ID',
				),
			},
		];
	}

	return [
		{ arg: 'fullpath', type: 'String', value: this.getNodeParameter('assetFullpath', itemIndex) },
	];
}

/**
 * Selection set for an asset, plus the file itself when asked for.
 *
 * `data` is deliberately absent from the automatic selection — see BINARY_FIELDS
 * in QueryBuilder — so downloading is an explicit choice that also pulls in the
 * filename and mimetype needed to build an n8n binary.
 */
function assetSelection(
	this: IExecuteFunctions,
	schema: SchemaIndex | null,
	itemIndex: number,
	typeName: string,
): string {
	const mode = this.getNodeParameter('assetFieldSelection', itemIndex, 'auto') as
		| 'auto'
		| 'selected'
		| 'raw';

	const extra: string[] = [];

	if (this.getNodeParameter('downloadFile', itemIndex, false) === true) {
		const thumbnail = (additionalField<string>).call(this, 'thumbnail', itemIndex, '').trim();

		extra.push(
			thumbnail === '' ? 'data' : `data(thumbnail: ${JSON.stringify(thumbnail)})`,
			'filename',
			'mimetype',
		);
	}

	return buildSelectionSet(schema, typeName, {
		mode,
		fields: this.getNodeParameter('assetFieldNames', itemIndex, []) as string[],
		raw: this.getNodeParameter('assetRawSelection', itemIndex, '') as string,
		maxDepth: 0,
		extra,
	});
}

/**
 * Turns a downloaded asset into an n8n item with binary data attached.
 *
 * Datahub hands the file back base64 encoded inside the JSON response, so the
 * decode happens here rather than over a second HTTP request.
 */
async function assetToItem(
	this: IExecuteFunctions,
	node: IDataObject,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const download = this.getNodeParameter('downloadFile', itemIndex, false) === true;

	if (!download || typeof node.data !== 'string' || node.data === '') {
		return toItem(node, itemIndex);
	}

	const property = (additionalField<string>)
		.call(this, 'outputBinaryField', itemIndex, 'data')
		.trim();
	const buffer = Buffer.from(node.data, 'base64');

	// The base64 blob is now in the binary slot; leaving it in json as well would
	// double the item's memory footprint for no benefit.
	const json = { ...node };
	delete json.data;

	return {
		json,
		binary: {
			[property || 'data']: await this.helpers.prepareBinaryData(
				buffer,
				(node.filename as string) ?? 'asset',
				(node.mimetype as string) ?? undefined,
			),
		},
		pairedItem: { item: itemIndex },
	};
}

/** Reads one asset per input item, batched into a single document. */
async function executeAssetGet(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];
	const mode = this.getNodeParameter('assetFieldSelection', 0, 'auto') as string;
	const schema = await schemaFor.call(this, mode !== 'raw');
	const batchSize = (assetOptions.call(this, 0).batchSize as number) ?? 1;

	for (const batch of chunk(
		items.map((_item, index) => index),
		batchSize,
	)) {
		const operations: AliasedOperation[] = [];
		const aliasToItem = new Map<string, number>();

		for (const itemIndex of batch) {
			const alias = `op${itemIndex}`;

			operations.push({
				alias,
				field: 'getAsset',
				args: assetIdentityArgs.call(this, itemIndex),
				selection: assetSelection.call(this, schema, itemIndex, 'asset'),
			});
			aliasToItem.set(alias, itemIndex);
		}

		const response = await graphqlRequest.call(this, buildDocument('query', operations), false);
		const errorsByAlias = groupErrorsByAlias(response.errors ?? []);

		throwOnGlobalErrors.call(this, errorsByAlias);

		for (const [alias, itemIndex] of aliasToItem) {
			const aliasErrors = errorsByAlias.get(alias);

			if (aliasErrors?.length) {
				failItem.call(this, output, itemIndex, formatErrors(aliasErrors));
				continue;
			}

			const node = (response.data as IDataObject | undefined)?.[alias] as IDataObject | null;

			if (node === null || node === undefined) {
				failItem.call(this, output, itemIndex, 'Asset not found');
				continue;
			}

			output.push(await assetToItem.call(this, node, itemIndex));
		}
	}

	return output;
}

/** Lists assets, paging through the whole result set when asked to. */
async function executeAssetGetAll(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];
	const mode = this.getNodeParameter('assetFieldSelection', 0, 'auto') as string;
	const schema = await schemaFor.call(this, mode !== 'raw');

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
			const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
			const filters = this.getNodeParameter('assetFilters', itemIndex, {}) as IDataObject;
			const pageSize = (assetOptions.call(this, itemIndex).pageSize as number) ?? 50;
			// The listing hands back `asset_tree`, a union of asset and asset_folder,
			// so the selection has to be written as inline fragments.
			const selection = assetSelection.call(this, schema, itemIndex, 'asset_tree');

			const baseArgs: GraphqlArg[] = [];

			if (filters.filter) {
				baseArgs.push({
					arg: 'filter',
					type: 'String',
					value:
						typeof filters.filter === 'string' ? filters.filter : JSON.stringify(filters.filter),
				});
			}
			for (const key of ['ids', 'fullpaths'] as const) {
				if (filters[key]) {
					baseArgs.push({ arg: key, type: 'String', value: filters[key] });
				}
			}
			for (const key of ['sortBy', 'sortOrder'] as const) {
				if (filters[key]) {
					baseArgs.push({
						arg: key,
						type: '[String]',
						value: String(filters[key])
							.split(',')
							.map((entry) => entry.trim()),
					});
				}
			}

			let offset = 0;
			let collected = 0;

			while (collected < (returnAll ? Number.POSITIVE_INFINITY : limit)) {
				const wanted = returnAll ? pageSize : Math.min(pageSize, limit - collected);

				const document = buildDocument('query', [
					{
						alias: 'listing',
						field: 'getAssetListing',
						args: [
							...baseArgs,
							{ arg: 'first', type: 'Int', value: wanted },
							{ arg: 'after', type: 'Int', value: offset },
						],
						selection: `    totalCount\n    edges {\n      node {\n${selection}\n      }\n    }`,
					},
				]);

				const response = await graphqlRequest.call(this, document);
				const listing = (response.data as IDataObject | undefined)?.listing as
					| { totalCount?: number; edges?: Array<{ node: IDataObject }> }
					| undefined;
				const edges = listing?.edges ?? [];

				for (const edge of edges) {
					output.push(await assetToItem.call(this, edge.node, itemIndex));
				}

				collected += edges.length;
				offset += edges.length;

				if (edges.length === 0 || edges.length < wanted) break;
			}
		} catch (error) {
			failItemFromError.call(this, output, itemIndex, error);
		}
	}

	return output;
}

/** Metadata entries as Datahub's `MetadataItem` input expects them. */
function assetMetadataInput(this: IExecuteFunctions, itemIndex: number): IDataObject[] {
	const collection = this.getNodeParameter('assetMetadata', itemIndex, {}) as {
		entry?: Array<{ name?: string; type?: string; data?: string; language?: string }>;
	};

	return (collection.entry ?? [])
		.filter((entry) => (entry.name ?? '').trim() !== '')
		.map((entry) => {
			const item: IDataObject = {
				name: entry.name,
				type: entry.type ?? 'input',
				data: entry.data ?? '',
			};

			if ((entry.language ?? '').trim() !== '') {
				item.language = entry.language;
			}

			return item;
		});
}

/** Reads the binary property of an input item and base64 encodes it. */
async function assetBinaryData(this: IExecuteFunctions, itemIndex: number): Promise<string> {
	const property = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, property);

	return buffer.toString('base64');
}

/** Uploads, updates or deletes assets, in batches. */
async function executeAssetWrite(
	this: IExecuteFunctions,
	items: INodeExecutionData[],
	operation: 'uploadAsset' | 'updateAsset' | 'deleteAsset',
): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];
	const options = assetOptions.call(this, 0);
	const batchSize = (options.batchSize as number) ?? 1;
	const field =
		operation === 'uploadAsset'
			? 'createAsset'
			: operation === 'updateAsset'
				? 'updateAsset'
				: 'deleteAsset';
	// Asset mutations name their result `assetData`, where object mutations use
	// `output`. Nothing in the schema hints at the inconsistency.
	const selection =
		operation === 'deleteAsset'
			? '    success\n    message'
			: '    success\n    message\n    assetData {\n      id\n      fullpath\n      filename\n      mimetype\n      filesize\n      type\n    }';

	for (const batch of chunk(
		items.map((_item, index) => index),
		batchSize,
	)) {
		const operations: AliasedOperation[] = [];
		const aliasToItem = new Map<string, number>();

		for (const itemIndex of batch) {
			try {
				const alias = `op${itemIndex}`;
				const args: GraphqlArg[] = [];

				if (operation === 'deleteAsset') {
					args.push(...assetIdentityArgs.call(this, itemIndex));
				} else if (operation === 'uploadAsset') {
					const input: IDataObject = { data: await assetBinaryData.call(this, itemIndex) };
					const metadata = assetMetadataInput.call(this, itemIndex);

					if (metadata.length > 0) input.metadata = metadata;

					const filename = this.getNodeParameter('assetFilename', itemIndex) as string;

					args.push({ arg: 'filename', type: 'String!', value: filename });
					args.push({
						arg: 'type',
						type: 'String!',
						value: resolveAssetType.call(this, itemIndex, filename),
					});

					if ((this.getNodeParameter('assetParentBy', itemIndex, 'path') as string) === 'path') {
						args.push({
							arg: 'path',
							type: 'String',
							value: this.getNodeParameter('assetParentPath', itemIndex),
						});
					} else {
						args.push({
							arg: 'parentId',
							type: 'Int',
							value: toElementId(
								this.getNodeParameter('assetParentId', itemIndex),
								this,
								itemIndex,
								'Parent ID',
							),
						});
					}

					args.push({ arg: 'input', type: 'AssetInput', value: input });
				} else {
					const input: IDataObject = {};
					const metadata = assetMetadataInput.call(this, itemIndex);

					if (metadata.length > 0) input.metadata = metadata;
					if (this.getNodeParameter('replaceFile', itemIndex, false) === true) {
						input.data = await assetBinaryData.call(this, itemIndex);
					}

					if (Object.keys(input).length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'Nothing to update: add metadata entries, or switch on Replace File',
							{ itemIndex },
						);
					}

					args.push(...assetIdentityArgs.call(this, itemIndex));

					if (options.omitVersionCreate) {
						args.push({ arg: 'omitVersionCreate', type: 'Boolean', value: true });
					}

					args.push({ arg: 'input', type: 'AssetInput', value: input });
				}

				operations.push({ alias, field, args, selection });
				aliasToItem.set(alias, itemIndex);
			} catch (error) {
				failItemFromError.call(this, output, itemIndex, error);
			}
		}

		if (operations.length === 0) continue;

		await runMutationBatch.call(this, operations, aliasToItem, output, 'assetData');
	}

	return output;
}

/**
 * Decides the Pimcore asset subclass for an upload.
 *
 * `createAsset` turns this straight into `Pimcore\\Model\\Asset\\<Type>`, so a
 * wrong value produces an asset of the wrong class rather than a clear error.
 * Detection reads the binary's own mime type, which n8n already carries.
 */
function resolveAssetType(this: IExecuteFunctions, itemIndex: number, filename: string): string {
	const chosen = (additionalField<string>).call(this, 'assetType', itemIndex, 'auto');

	if (chosen !== 'auto') return chosen;

	const property = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;
	const mimeType = this.helpers.assertBinaryData(itemIndex, property).mimeType ?? '';

	if (mimeType.startsWith('image/')) return 'image';
	if (mimeType.startsWith('video/')) return 'video';
	if (mimeType.startsWith('audio/')) return 'audio';
	if (mimeType.startsWith('text/')) return 'text';

	if (/(pdf|msword|officedocument|opendocument|rtf|postscript)/.test(mimeType)) return 'document';
	if (/(zip|tar|gzip|x-7z|x-rar|compressed)/.test(mimeType)) return 'archive';

	// A filename can still settle it when the mime type is a generic octet-stream.
	const extension = (filename.split('.').pop() ?? '').toLowerCase();
	if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tif', 'tiff'].includes(extension)) return 'image';
	if (['pdf', 'doc', 'docx', 'odt', 'rtf'].includes(extension)) return 'document';
	if (['zip', 'tar', 'gz', '7z', 'rar'].includes(extension)) return 'archive';

	return 'unknown';
}
