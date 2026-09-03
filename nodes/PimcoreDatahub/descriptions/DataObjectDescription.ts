import type { INodeProperties } from 'n8n-workflow';

const showForDataObject = { resource: ['dataObject'] };

/** Operations that address one existing object. */
const LOOKUP_OPERATIONS = ['get', 'update', 'delete'];

/** Operations that write. */
const WRITE_OPERATIONS = ['create', 'update', 'createOrUpdate', 'delete'];

/** Write operations that carry field values. */
const INPUT_OPERATIONS = ['create', 'update', 'createOrUpdate'];

export const dataObjectOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: showForDataObject },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Create a new data object',
				action: 'Create a data object',
			},
			{
				name: 'Create or Update',
				value: 'createOrUpdate',
				description: 'Update a matching object, or create it when none exists (upsert)',
				action: 'Create or update a data object',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a data object',
				action: 'Delete a data object',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Retrieve one data object',
				action: 'Get a data object',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Retrieve many data objects',
				action: 'Get many data objects',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Update an existing data object',
				action: 'Update a data object',
			},
		],
		default: 'getAll',
	},
];

export const dataObjectFields: INodeProperties[] = [
	{
		// A resource locator rather than a plain dropdown: the list needs a working
		// connection and an endpoint that permits introspection, and neither is
		// guaranteed. By Name always works, takes expressions, and lets one node
		// serve a workflow that walks several classes.
		displayName: 'Class',
		name: 'className',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		displayOptions: { show: showForDataObject },
		description: 'The Pimcore class to work with',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchClasses', searchable: true },
			},
			{
				displayName: 'By Name',
				name: 'name',
				type: 'string',
				placeholder: 'CustomProduct',
				hint: 'The class name as defined in Pimcore, case sensitive',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: '^[A-Za-z_][A-Za-z0-9_]*$',
							errorMessage: 'A Pimcore class name contains only letters, digits and underscores',
						},
					},
				],
			},
		],
	},

	// ------------------------------------------------------------ lookup
	{
		displayName: 'Look Up By',
		name: 'lookupBy',
		type: 'options',
		options: [
			{ name: 'ID', value: 'id' },
			{ name: 'Full Path', value: 'fullpath' },
		],
		default: 'id',
		displayOptions: {
			show: { ...showForDataObject, operation: LOOKUP_OPERATIONS },
		},
	},
	{
		displayName: 'Object ID',
		name: 'objectId',
		type: 'number',
		default: 0,
		required: true,
		displayOptions: {
			show: {
				...showForDataObject,
				operation: LOOKUP_OPERATIONS,
				lookupBy: ['id'],
			},
		},
	},
	{
		displayName: 'Full Path',
		name: 'fullpath',
		type: 'string',
		default: '',
		required: true,
		placeholder: '/products/my-product',
		displayOptions: {
			show: {
				...showForDataObject,
				operation: LOOKUP_OPERATIONS,
				lookupBy: ['fullpath'],
			},
		},
	},

	// ------------------------------------------------------------ get many
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { ...showForDataObject, operation: ['getAll'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: {
			show: { ...showForDataObject, operation: ['getAll'], returnAll: [false] },
		},
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { ...showForDataObject, operation: ['getAll'] } },
		options: [
			{
				displayName: 'Filter',
				name: 'filter',
				type: 'json',
				default: '',
				placeholder: '{"number": {"$like": "SW-%"}}',
				description:
					'Pimcore Datahub filter, as JSON. A bare value means equals, as in {"number": "SW-100"} - there is no $eq operator. The operators are $like, $notlike, $not, $notnull, $gt, $gte, $lt, $lte, and $and / $or for grouping.',
			},
			{
				displayName: 'Full Paths',
				name: 'fullpaths',
				type: 'string',
				default: '',
				placeholder: '/products/a,/products/b',
				description: 'Comma-separated list of full paths',
			},
			{
				displayName: 'IDs',
				name: 'ids',
				type: 'string',
				default: '',
				placeholder: '1042,1043',
				description: 'Comma-separated list of object IDs',
			},
			{
				displayName: 'Published Only',
				name: 'published',
				type: 'boolean',
				default: true,
				description: 'Whether to return only published objects',
			},
			{
				displayName: 'Sort By',
				name: 'sortBy',
				type: 'string',
				default: '',
				placeholder: 'number',
				description: 'Comma-separated list of field names to sort by',
			},
			{
				displayName: 'Sort Order',
				name: 'sortOrder',
				type: 'string',
				default: '',
				placeholder: 'ASC,DESC',
				description: 'Comma-separated list of ASC or DESC, one per entry of Sort By',
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				description: 'Comma-separated list of tag names',
			},
		],
	},

	// ------------------------------------------------------------ create
	{
		displayName: 'Key',
		name: 'key',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'my-product',
		displayOptions: { show: { ...showForDataObject, operation: ['create'] } },
		description: 'Object key, which becomes the last segment of its full path',
	},
	{
		displayName: 'Parent',
		name: 'parentBy',
		type: 'options',
		options: [
			{ name: 'Path', value: 'path' },
			{ name: 'ID', value: 'id' },
		],
		default: 'path',
		displayOptions: {
			show: { ...showForDataObject, operation: ['create', 'createOrUpdate'] },
		},
	},
	{
		displayName: 'Parent Path',
		name: 'parentPath',
		type: 'string',
		default: '',
		required: true,
		placeholder: '/products',
		displayOptions: {
			show: {
				...showForDataObject,
				operation: ['create', 'createOrUpdate'],
				parentBy: ['path'],
			},
		},
	},
	{
		displayName: 'Parent ID',
		name: 'parentId',
		type: 'number',
		default: 1,
		required: true,
		displayOptions: {
			show: {
				...showForDataObject,
				operation: ['create', 'createOrUpdate'],
				parentBy: ['id'],
			},
		},
	},
	// ------------------------------------------------------------ upsert
	{
		displayName: 'Match By',
		name: 'matchBy',
		type: 'options',
		options: [
			{
				name: 'Field Value',
				value: 'field',
				description: 'Look the object up by a field, e.g. an article number',
			},
			{ name: 'ID', value: 'id' },
			{ name: 'Full Path', value: 'fullpath' },
		],
		default: 'field',
		displayOptions: {
			show: { ...showForDataObject, operation: ['createOrUpdate'] },
		},
		description: 'How an incoming item is matched against an existing object',
	},
	{
		displayName: 'Match Field',
		name: 'matchField',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'number',
		displayOptions: {
			show: {
				...showForDataObject,
				operation: ['createOrUpdate'],
				matchBy: ['field'],
			},
		},
		description: 'Name of the field to match on. It must be filterable in the endpoint schema.',
	},
	{
		displayName: 'Match Value',
		name: 'matchValue',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				...showForDataObject,
				operation: ['createOrUpdate'],
				matchBy: ['field'],
			},
		},
	},
	{
		displayName: 'Object ID',
		name: 'objectId',
		type: 'number',
		default: 0,
		required: true,
		displayOptions: {
			show: {
				...showForDataObject,
				operation: ['createOrUpdate'],
				matchBy: ['id'],
			},
		},
	},
	{
		displayName: 'Full Path',
		name: 'fullpath',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				...showForDataObject,
				operation: ['createOrUpdate'],
				matchBy: ['fullpath'],
			},
		},
	},
	{
		displayName: 'If Not Found',
		name: 'ifNotFound',
		type: 'options',
		options: [
			{ name: 'Create', value: 'create', description: 'Create a new object' },
			{
				name: 'Skip',
				value: 'skip',
				description: 'Pass the item through untouched',
			},
			{ name: 'Fail Item', value: 'error', description: 'Fail this item' },
		],
		default: 'create',
		displayOptions: {
			show: { ...showForDataObject, operation: ['createOrUpdate'] },
		},
	},

	// ------------------------------------------------------------ input
	{
		// Raw JSON is not a legacy escape hatch, it is the only mode that works on
		// an endpoint with introspection disabled: the mapper has no field list to
		// offer there. Mirrors the auto / selected / raw choice the read side uses.
		displayName: 'Input Mode',
		name: 'inputMode',
		type: 'options',
		options: [
			{
				name: 'Mapped Fields',
				value: 'mapped',
				description: 'Pick fields from the class schema and map a value to each',
			},
			{
				name: 'Raw JSON',
				value: 'json',
				description:
					'Supply the whole input object as JSON. The only mode available when the endpoint has introspection disabled.',
			},
		],
		default: 'mapped',
		displayOptions: {
			show: { ...showForDataObject, operation: INPUT_OPERATIONS },
		},
		description: 'How the field values for this write are supplied',
	},
	{
		// mode 'add' rather than 'update' / 'upsert' on purpose: the matching
		// columns the mapper would offer are a second, weaker way to express what
		// Look Up By and Match By already do, and Pimcore matches on id, full path
		// or a filterable field rather than on the written columns.
		displayName: 'Fields to Write',
		name: 'fieldsToWrite',
		type: 'resourceMapper',
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		noDataExpression: true,
		typeOptions: {
			loadOptionsDependsOn: ['className.value'],
			resourceMapper: {
				resourceMapperMethod: 'getWritableFields',
				mode: 'add',
				fieldWords: { singular: 'field', plural: 'fields' },
				// Pimcore classes are wide - a product class routinely carries forty
				// attributes - so fields are opted into rather than all pre-added.
				addAllFields: false,
				supportAutoMap: true,
			},
		},
		displayOptions: {
			show: { ...showForDataObject, operation: INPUT_OPERATIONS, inputMode: ['mapped'] },
		},
	},
	{
		displayName: 'Input',
		name: 'input',
		type: 'json',
		default: '{}',
		required: true,
		displayOptions: {
			show: {
				...showForDataObject,
				operation: INPUT_OPERATIONS,
				inputMode: ['json'],
			},
		},
		description:
			'Field values to write, as JSON. Relations take {"ID": 123} or {"fullpath": "/a/b"} entries. Localized fields are written in the language given by Default Language.',
	},
	// Split per operation rather than one collection for both: Create already
	// takes Key as a required field above, so offering it here as well would give
	// two places to set one value.
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { ...showForDataObject, operation: ['create'] } },
		options: [
			{
				displayName: 'Published',
				name: 'published',
				type: 'boolean',
				default: true,
				description: 'Whether the created object is published',
			},
		],
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { ...showForDataObject, operation: ['createOrUpdate'] } },
		options: [
			{
				displayName: 'Key',
				name: 'key',
				type: 'string',
				default: '',
				placeholder: 'my-product',
				description:
					'Object key used when creating, which becomes the last segment of the full path. Leave empty to derive it from the match value.',
			},
			{
				displayName: 'Published',
				name: 'published',
				type: 'boolean',
				default: true,
				description: 'Whether a newly created object is published',
			},
		],
	},

	// ------------------------------------------------------------ selection
	{
		displayName: 'Fields',
		name: 'fieldSelection',
		type: 'options',
		options: [
			{
				name: 'All Scalar Fields',
				value: 'auto',
				description: 'Every plain field, plus ID and full path of related objects',
			},
			{
				name: 'Selected Fields',
				value: 'selected',
				description: 'Pick fields from the schema',
			},
			{
				name: 'Raw Selection Set',
				value: 'raw',
				description: 'Write the GraphQL selection by hand',
			},
		],
		default: 'auto',
		displayOptions: {
			show: { ...showForDataObject, operation: ['get', 'getAll'] },
		},
		description: 'Which fields to return. GraphQL returns only what is asked for.',
	},
	{
		displayName: 'Field Names or IDs',
		name: 'fields',
		type: 'multiOptions',
		typeOptions: {
			loadOptionsMethod: 'getFields',
			loadOptionsDependsOn: ['className.value'],
		},
		default: [],
		displayOptions: {
			show: {
				...showForDataObject,
				operation: ['get', 'getAll'],
				fieldSelection: ['selected'],
			},
		},
		description:
			'Fields to return. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Selection Set',
		name: 'rawSelection',
		type: 'string',
		typeOptions: { rows: 6 },
		default: 'id\nfullpath',
		displayOptions: {
			show: {
				...showForDataObject,
				operation: ['get', 'getAll'],
				fieldSelection: ['raw'],
			},
		},
		description:
			'GraphQL selection set body, without the outer braces. The only mode available when the endpoint has introspection disabled.',
	},

	// ------------------------------------------------------------ options
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showForDataObject },
		options: [
			{
				displayName: 'Batch Size',
				name: 'batchSize',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 25,
				description:
					'How many items to send per request. Batched calls run one after another inside a single GraphQL document; they are not a transaction, so a failure part way through leaves earlier writes in place. Set to 1 to send one request per item.',
			},
			{
				displayName: 'Default Language',
				name: 'defaultLanguage',
				type: 'string',
				default: '',
				placeholder: 'en',
				description:
					'Language used for localized fields. One call reads or writes one language; to write several, send the item once per language.',
			},
			{
				displayName: 'Omit Mandatory Check',
				name: 'omitMandatoryCheck',
				type: 'boolean',
				default: false,
				description: 'Whether to save even when mandatory fields are empty',
			},
			{
				displayName: 'Omit Version Create',
				name: 'omitVersionCreate',
				type: 'boolean',
				default: false,
				description:
					'Whether to skip writing a version entry. Useful for high volume imports, at the cost of losing the change history.',
			},
			{
				displayName: 'Page Size',
				name: 'pageSize',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'How many objects to fetch per request when returning all results',
			},
			{
				displayName: 'Relation Depth',
				name: 'maxDepth',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 3 },
				default: 1,
				description:
					'How far to follow relations when returning all scalar fields. 0 omits relations entirely.',
			},
			{
				displayName: 'Return Written Object',
				name: 'returnWrittenObject',
				type: 'boolean',
				default: false,
				description:
					'Whether write operations return every scalar field of the saved object instead of just its identity. Relations are never returned from a write - read them back with a Get.',
			},
		],
	},
];

export { WRITE_OPERATIONS };
