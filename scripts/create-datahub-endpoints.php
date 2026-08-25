<?php

/**
 * Creates the Datahub GraphQL endpoints used to develop and test
 * @scope01gmbh/n8n-nodes-pimcore-datahub against this instance.
 *
 *   n8n_read       read-only: CustomProduct plus read access to all assets
 *   n8n_readwrite  same, full CRUD, writes fenced to the /n8n-sandbox folders
 *   n8n_locked     read-only, introspection disabled (degraded-path testing)
 *
 * Idempotent: re-running replaces the configs and their workspaces.
 */

require '/var/www/html/vendor/autoload.php';
\Pimcore\Bootstrap::startupCli();

use Pimcore\Bundle\DataHubBundle\Configuration;
use Pimcore\Bundle\DataHubBundle\WorkspaceHelper;
use Pimcore\Model\DataObject;
use Pimcore\Model\DataObject\ClassDefinition;

const CLASSES        = ['CustomProduct'];
const SANDBOX        = '/n8n-sandbox';
const READ_ROOT      = '/custom products';
const ASSET_READ     = '/';
const ASSET_SANDBOX  = '/n8n-sandbox';

$keys = [
    'n8n_read'      => 'n8nread0000000000000000000000000',
    'n8n_readwrite' => 'n8nwrite000000000000000000000000',
    'n8n_locked'    => 'n8nlocked00000000000000000000000',
];

/** Datatypes we deliberately leave out of the generated schema. */
const SKIP_TYPES = ['objectbricks', 'fieldcollections', 'block', 'classificationstore', 'localizedfields'];

$service = \Pimcore::getContainer()->get(\Pimcore\Bundle\DataHubBundle\GraphQL\Service::class);

function column(string $attribute, string $dataType, ?string $label = null): array
{
    return [
        'isOperator' => false,
        'attributes' => [
            'attribute' => $attribute,
            'dataType'  => $dataType,
            'label'     => $label ?? $attribute,
        ],
    ];
}

/**
 * Builds a columnConfig for a class: system columns + every field the
 * Datahub supports for the given operation, localized children flattened.
 */
function columnsFor(string $className, string $operation, $service): array
{
    $class   = ClassDefinition::getByName($className);
    $helper  = $service->getObjectFieldHelper();
    $columns = [
        column('fullpath', 'system'),
        column('key', 'system'),
        column('published', 'system'),
    ];

    $collect = function (array $defs) use (&$columns, $helper, $operation) {
        foreach ($defs as $fd) {
            $type = $fd->getFieldtype();
            if (in_array($type, SKIP_TYPES, true)) {
                continue;
            }
            if (!$helper->supportsGraphQL($fd, $operation)) {
                continue;
            }
            $columns[] = column($fd->getName(), $type, $fd->getTitle() ?: $fd->getName());
        }
    };

    $collect($class->getFieldDefinitions());

    /** @var ClassDefinition\Data\Localizedfields|null $lf */
    $lf = $class->getFieldDefinition('localizedfields');
    if ($lf) {
        $collect($lf->getFieldDefinitions());
    }

    return ['columns' => $columns];
}

function queryEntities(array $classNames, $service): array
{
    $out = [];
    foreach ($classNames as $cn) {
        $out[$cn] = ['columnConfig' => columnsFor($cn, 'query', $service)];
    }

    return $out;
}

function mutationEntities(array $classNames, $service): array
{
    $out = [];
    foreach ($classNames as $cn) {
        $out[$cn] = [
            'create'       => true,
            'update'       => true,
            'delete'       => true,
            'columnConfig' => columnsFor($cn, 'mutation', $service),
        ];
    }

    return $out;
}

function writeConfig(string $name, array $configuration, array $workspaces): void
{
    // Configuration has no update-in-place API, so drop any previous incarnation first.
    if ($existing = Configuration::getByName($name)) {
        WorkspaceHelper::deleteConfiguration($existing);
        $existing->delete();
    }

    $config = new Configuration('graphql', '/', $name, $configuration);
    $config->save();
    WorkspaceHelper::saveWorkspaces($config, $workspaces);
}

// ---------------------------------------------------------------- sandbox

$sandbox = DataObject::getByPath(SANDBOX);
if (!$sandbox) {
    $sandbox = new DataObject\Folder();
    $sandbox->setParentId(1);
    $sandbox->setKey(ltrim(SANDBOX, '/'));
    $sandbox->save();
    echo "created folder " . SANDBOX . " (id " . $sandbox->getId() . ")\n";
} else {
    echo "folder " . SANDBOX . " exists (id " . $sandbox->getId() . ")\n";
}

$assetSandbox = \Pimcore\Model\Asset::getByPath(ASSET_SANDBOX);
if (!$assetSandbox) {
    $assetSandbox = new \Pimcore\Model\Asset\Folder();
    $assetSandbox->setParentId(1);
    $assetSandbox->setFilename(ltrim(ASSET_SANDBOX, '/'));
    $assetSandbox->save();
    echo "created asset folder " . ASSET_SANDBOX . " (id " . $assetSandbox->getId() . ")\n";
} else {
    echo "asset folder " . ASSET_SANDBOX . " exists (id " . $assetSandbox->getId() . ")\n";
}

$query    = queryEntities(CLASSES, $service);
$mutation = mutationEntities(CLASSES, $service);

// ---------------------------------------------------------------- n8n_read

writeConfig('n8n_read', [
    'general' => [
        'name'        => 'n8n_read',
        'type'        => 'graphql',
        'path'        => '/',
        'active'      => true,
        'group'       => 'n8n',
        'description' => 'Read-only endpoint for the n8n Pimcore Datahub node.',
    ],
    'schema' => [
        'queryEntities'    => $query,
        'mutationEntities' => [],
        'specialEntities'  => [
            'asset'         => ['read' => true, 'create' => false, 'update' => false, 'delete' => false],
            'asset_listing' => ['read' => true],
        ],
    ],
    'security' => [
        'method'               => Configuration::SECURITYCONFIG_AUTH_APIKEY,
        'apikey'               => $keys['n8n_read'],
        'disableIntrospection' => false,
    ],
    'permissions' => [],
], [
    'object' => [['cpath' => READ_ROOT,   'read' => 1, 'create' => 0, 'update' => 0, 'delete' => 0]],
    'asset'  => [['cpath' => ASSET_READ,  'read' => 1, 'create' => 0, 'update' => 0, 'delete' => 0]],
]);
echo "wrote n8n_read\n";

// ----------------------------------------------------------- n8n_readwrite

writeConfig('n8n_readwrite', [
    'general' => [
        'name'        => 'n8n_readwrite',
        'type'        => 'graphql',
        'path'        => '/',
        'active'      => true,
        'group'       => 'n8n',
        'description' => 'Read/write endpoint for the n8n node. Writes are fenced to ' . SANDBOX . '.',
    ],
    'schema' => [
        'queryEntities'    => $query,
        'mutationEntities' => $mutation,
        'specialEntities'  => [
            'asset'         => ['read' => true, 'create' => true, 'update' => true, 'delete' => true],
            'asset_listing' => ['read' => true],
        ],
    ],
    'security' => [
        'method'               => Configuration::SECURITYCONFIG_AUTH_APIKEY,
        'apikey'               => $keys['n8n_readwrite'],
        'disableIntrospection' => false,
    ],
    'permissions' => [],
], [
    'object' => [
        ['cpath' => READ_ROOT, 'read' => 1, 'create' => 0, 'update' => 0, 'delete' => 0],
        ['cpath' => SANDBOX,   'read' => 1, 'create' => 1, 'update' => 1, 'delete' => 1],
    ],
    'asset' => [
        ['cpath' => ASSET_READ,    'read' => 1, 'create' => 0, 'update' => 0, 'delete' => 0],
        ['cpath' => ASSET_SANDBOX, 'read' => 1, 'create' => 1, 'update' => 1, 'delete' => 1],
    ],
]);
echo "wrote n8n_readwrite\n";

// -------------------------------------------------------------- n8n_locked

writeConfig('n8n_locked', [
    'general' => [
        'name'        => 'n8n_locked',
        'type'        => 'graphql',
        'path'        => '/',
        'active'      => true,
        'group'       => 'n8n',
        'description' => 'Introspection disabled, ShopwareProduct only. Exercises the node degraded path.',
    ],
    'schema' => [
        'queryEntities'    => ['CustomProduct' => $query['CustomProduct']],
        'mutationEntities' => [],
        'specialEntities'  => [],
    ],
    'security' => [
        'method'               => Configuration::SECURITYCONFIG_AUTH_APIKEY,
        'apikey'               => $keys['n8n_locked'],
        'disableIntrospection' => true,
    ],
    'permissions' => [],
], [
    'object' => [['cpath' => READ_ROOT, 'read' => 1, 'create' => 0, 'update' => 0, 'delete' => 0]],
]);
echo "wrote n8n_locked\n";

echo "\ncolumns per class (query schema):\n";
foreach (CLASSES as $cn) {
    echo '  ' . str_pad($cn, 24) . count($query[$cn]['columnConfig']['columns']) . "\n";
}

echo "\nendpoints:\n";
foreach ($keys as $name => $key) {
    echo '  http://pimcore-x.local/pimcore-graphql-webservices/' . str_pad($name, 16) . ' X-API-Key: ' . $key . "\n";
}
