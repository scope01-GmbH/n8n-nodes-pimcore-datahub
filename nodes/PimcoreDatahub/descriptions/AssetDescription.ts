import type { INodeProperties } from 'n8n-workflow';

const showForAsset = { resource: ['asset'] };

/** Asset operations that address one existing asset. */
const ASSET_LOOKUP = ['getAsset', 'updateAsset', 'deleteAsset'];

export const assetOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: showForAsset },
		options: [
			{
				name: 'Delete',
				value: 'deleteAsset',
				description: 'Delete an asset',
				action: 'Delete an asset',
			},
			{
				name: 'Get',
				value: 'getAsset',
				description: 'Retrieve one asset, optionally with its file',
				action: 'Get an asset',
			},
			{
				name: 'Get Many',
				value: 'getAllAssets',
				description: 'Retrieve many assets',
				action: 'Get many assets',
			},
			{
				name: 'Update',
				value: 'updateAsset',
				description: 'Replace an asset file or write its metadata',
				action: 'Update an asset',
			},
			{
				name: 'Upload',
				value: 'uploadAsset',
				description: 'Upload a file from binary data as a new asset',
				action: 'Upload an asset',
			},
		],
		default: 'getAllAssets',
	},
];

export const assetFields: INodeProperties[] = [
	// ------------------------------------------------------------ lookup
	{
		displayName: 'Look Up By',
		name: 'assetLookupBy',
		type: 'options',
		options: [
			{ name: 'ID', value: 'id' },
			{ name: 'Full Path', value: 'fullpath' },
		],
		default: 'id',
		displayOptions: { show: { ...showForAsset, operation: ASSET_LOOKUP } },
	},
	{
		displayName: 'Asset ID',
		name: 'assetId',
		type: 'number',
		default: 0,
		required: true,
		displayOptions: {
			show: { ...showForAsset, operation: ASSET_LOOKUP, assetLookupBy: ['id'] },
		},
	},
	{
		displayName: 'Full Path',
		name: 'assetFullpath',
		type: 'string',
		default: '',
		required: true,
		placeholder: '/product-images/lamp.jpg',
		displayOptions: {
			show: { ...showForAsset, operation: ASSET_LOOKUP, assetLookupBy: ['fullpath'] },
		},
	},

	// ------------------------------------------------------------ get many
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { ...showForAsset, operation: ['getAllAssets'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: {
			show: { ...showForAsset, operation: ['getAllAssets'], returnAll: [false] },
		},
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'assetFilters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { ...showForAsset, operation: ['getAllAssets'] } },
		options: [
			{
				displayName: 'Filter',
				name: 'filter',
				type: 'json',
				default: '',
				placeholder: '{"type": "image"}',
				description:
					'Datahub filter, as JSON. A bare value means equals; there is no $eq operator.',
			},
			{
				displayName: 'Full Paths',
				name: 'fullpaths',
				type: 'string',
				default: '',
				description: 'Comma-separated list of full paths',
			},
			{
				displayName: 'IDs',
				name: 'ids',
				type: 'string',
				default: '',
				description: 'Comma-separated list of asset IDs',
			},
			{
				displayName: 'Sort By',
				name: 'sortBy',
				type: 'string',
				default: '',
				placeholder: 'filename',
				description: 'Comma-separated list of field names to sort by',
			},
			{
				displayName: 'Sort Order',
				name: 'sortOrder',
				type: 'string',
				default: '',
				placeholder: 'ASC',
				description: 'Comma-separated list of ASC or DESC, one per Sort By entry',
			},
		],
	},

	// ------------------------------------------------------------ upload
	{
		displayName: 'Filename',
		name: 'assetFilename',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'lamp.jpg',
		displayOptions: { show: { ...showForAsset, operation: ['uploadAsset'] } },
		description: 'Filename the asset gets in Pimcore, including its extension',
	},
	{
		displayName: 'Parent',
		name: 'assetParentBy',
		type: 'options',
		options: [
			{ name: 'Path', value: 'path' },
			{ name: 'ID', value: 'id' },
		],
		default: 'path',
		displayOptions: { show: { ...showForAsset, operation: ['uploadAsset'] } },
	},
	{
		displayName: 'Parent Path',
		name: 'assetParentPath',
		type: 'string',
		default: '',
		required: true,
		placeholder: '/product-images',
		displayOptions: {
			show: { ...showForAsset, operation: ['uploadAsset'], assetParentBy: ['path'] },
		},
	},
	{
		displayName: 'Parent ID',
		name: 'assetParentId',
		type: 'number',
		default: 1,
		required: true,
		displayOptions: {
			show: { ...showForAsset, operation: ['uploadAsset'], assetParentBy: ['id'] },
		},
	},

	// ------------------------------------------------------------ binary in
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		displayOptions: { show: { ...showForAsset, operation: ['uploadAsset'] } },
		hint: 'The name of the input binary field containing the file',
	},
	{
		displayName: 'Replace File',
		name: 'replaceFile',
		type: 'boolean',
		default: false,
		displayOptions: { show: { ...showForAsset, operation: ['updateAsset'] } },
		description: 'Whether to overwrite the asset file with binary data from the input item',
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		displayOptions: {
			show: { ...showForAsset, operation: ['updateAsset'], replaceFile: [true] },
		},
		hint: 'The name of the input binary field containing the replacement file',
	},

	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { ...showForAsset, operation: ['uploadAsset'] } },
		options: [
			{
				// `createAsset` maps this straight onto a Pimcore\Model\Asset
				// subclass, so it decides what the asset *is*, not merely how it is
				// labelled. Left out, the mime type of the binary decides.
				displayName: 'Asset Type',
				name: 'assetType',
				type: 'options',
				options: [
					{ name: 'Archive', value: 'archive' },
					{ name: 'Audio', value: 'audio' },
					{
						name: 'Detect From File',
						value: 'auto',
						description: 'Derive the type from the binary mime type',
					},
					{ name: 'Document', value: 'document' },
					{ name: 'Image', value: 'image' },
					{ name: 'Text', value: 'text' },
					{ name: 'Unknown', value: 'unknown' },
					{ name: 'Video', value: 'video' },
				],
				default: 'auto',
			},
		],
	},

	// ------------------------------------------------------------ metadata
	{
		displayName: 'Metadata',
		name: 'assetMetadata',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Metadata Entry',
		default: {},
		displayOptions: {
			show: { ...showForAsset, operation: ['uploadAsset', 'updateAsset'] },
		},
		options: [
			{
				displayName: 'Entry',
				name: 'entry',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						description: 'Metadata field name as defined in Pimcore',
					},
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						options: [
							{ name: 'Asset', value: 'asset' },
							{ name: 'Checkbox', value: 'checkbox' },
							{ name: 'Date', value: 'date' },
							{ name: 'Document', value: 'document' },
							{ name: 'Input', value: 'input' },
							{ name: 'Object', value: 'object' },
							{ name: 'Select', value: 'select' },
							{ name: 'Textarea', value: 'textarea' },
						],
						default: 'input',
					},
					{ displayName: 'Value', name: 'data', type: 'string', default: '' },
					{
						displayName: 'Language',
						name: 'language',
						type: 'string',
						default: '',
						description: 'Leave empty for language-independent metadata',
					},
				],
			},
		],
	},

	// ------------------------------------------------------------ binary out
	{
		displayName: 'Download File',
		name: 'downloadFile',
		type: 'boolean',
		default: false,
		displayOptions: { show: { ...showForAsset, operation: ['getAsset', 'getAllAssets'] } },
		description:
			'Whether to fetch the asset file itself and attach it as binary data. Datahub sends the file base64 encoded inside the GraphQL response, so this is memory hungry for large files or long listings.',
	},
	{
		// Gated on Download File rather than folded into it: the switch decides
		// whether the node emits binary data at all, and these two only have a
		// meaning once it is on.
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: {
			show: {
				...showForAsset,
				operation: ['getAsset', 'getAllAssets'],
				downloadFile: [true],
			},
		},
		options: [
			{
				displayName: 'Output Binary Field',
				name: 'outputBinaryField',
				type: 'string',
				default: 'data',
				hint: 'The name of the output binary field to put the file in',
			},
			{
				displayName: 'Thumbnail',
				name: 'thumbnail',
				type: 'string',
				default: '',
				placeholder: 'content',
				description:
					'Name of a Pimcore thumbnail configuration to download instead of the original file. Leave empty for the original.',
			},
		],
	},

	// ------------------------------------------------------------ selection
	{
		displayName: 'Fields',
		name: 'assetFieldSelection',
		type: 'options',
		options: [
			{
				name: 'All Scalar Fields',
				value: 'auto',
				description: 'Filename, path, type, mimetype, size and dates, without the file itself',
			},
			{ name: 'Selected Fields', value: 'selected', description: 'Pick fields from the schema' },
			{ name: 'Raw Selection Set', value: 'raw', description: 'Write the GraphQL selection by hand' },
		],
		default: 'auto',
		displayOptions: { show: { ...showForAsset, operation: ['getAsset', 'getAllAssets'] } },
	},
	{
		displayName: 'Field Names or IDs',
		name: 'assetFieldNames',
		type: 'multiOptions',
		typeOptions: { loadOptionsMethod: 'getAssetFields' },
		default: [],
		displayOptions: {
			show: {
				...showForAsset,
				operation: ['getAsset', 'getAllAssets'],
				assetFieldSelection: ['selected'],
			},
		},
		description:
			'Fields to return. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Selection Set',
		name: 'assetRawSelection',
		type: 'string',
		typeOptions: { rows: 5 },
		default: 'id\nfullpath\nfilename\nmimetype',
		displayOptions: {
			show: {
				...showForAsset,
				operation: ['getAsset', 'getAllAssets'],
				assetFieldSelection: ['raw'],
			},
		},
		description: 'GraphQL selection set body, without the outer braces',
	},

	// ------------------------------------------------------------ options
	{
		displayName: 'Options',
		name: 'assetOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showForAsset },
		options: [
			{
				displayName: 'Batch Size',
				name: 'batchSize',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 1,
				description:
					'How many items to send per request. Files travel base64 encoded inside the GraphQL document, so uploads default to one request per item; raise it only for metadata-only writes.',
			},
			{
				displayName: 'Omit Version Create',
				name: 'omitVersionCreate',
				type: 'boolean',
				default: false,
				description: 'Whether to skip writing a version entry, losing the change history',
			},
			{
				displayName: 'Page Size',
				name: 'pageSize',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'How many assets to fetch per request when returning all results',
			},
		],
	},
];
