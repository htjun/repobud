/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { parsePluginPackageManifest } from '../../../../../platform/repoBud/common/pluginPackage.js';
import { createCanonicalConfiguration, parseCanonicalConfiguration, serializeCanonicalConfiguration } from '../../common/canonicalConfiguration.js';
import {
	ICanonicalMcpDefinitionResource,
	inspectClaudeMcpProjection,
	parseCanonicalMcpDefinition,
	projectClaudeMcpDefinition,
	resolveEffectiveMcpIntegrations,
	serializeCanonicalMcpDefinition,
} from '../../common/mcpIntegration.js';
import { getRepositoryAvailability, RepositoryCatalogModel } from '../../common/repositoryCatalog.js';
import { REPOBUD_VIEW_CONTAINER_IDS, isRepoBudViewContainerAllowed } from '../../common/repoBud.js';
import { ICanonicalSkillDefinition, resolveEffectiveSkills } from '../../common/skillManagement.js';

suite('RepoBud product composition', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('allows only the three product areas in the primary side bar', () => {
		for (const id of Object.values(REPOBUD_VIEW_CONTAINER_IDS)) {
			assert.strictEqual(isRepoBudViewContainerAllowed(id, ViewContainerLocation.Sidebar), true);
			assert.strictEqual(isRepoBudViewContainerAllowed(id, ViewContainerLocation.Panel), false);
			assert.strictEqual(isRepoBudViewContainerAllowed(id, ViewContainerLocation.AuxiliaryBar), false);
		}
	});

	test('rejects upstream primary product areas', () => {
		for (const id of [
			'workbench.view.explorer',
			'workbench.view.search',
			'workbench.view.debug',
			'workbench.view.testing',
			'workbench.view.extensions',
			'workbench.panel.terminal',
			'workbench.panel.chat',
		]) {
			assert.strictEqual(isRepoBudViewContainerAllowed(id, ViewContainerLocation.Sidebar), false);
			assert.strictEqual(isRepoBudViewContainerAllowed(id, ViewContainerLocation.Panel), false);
			assert.strictEqual(isRepoBudViewContainerAllowed(id, ViewContainerLocation.AuxiliaryBar), false);
		}
	});
});

suite('Repository Catalog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('persists repositories without availability state', () => {
		const first = URI.file('/tmp/first');
		const second = URI.file('/tmp/second');
		const model = new RepositoryCatalogModel();

		model.add({ uri: first, availability: 'ready' });
		model.add({ uri: second, availability: 'notRepository' });

		const restored = RepositoryCatalogModel.restore(model.serialize());
		assert.deepStrictEqual(restored.entries.map(entry => entry.uri.toString()), [first.toString(), second.toString()]);
		assert.deepStrictEqual(restored.entries.map(entry => entry.availability), ['missing', 'missing']);
	});

	test('deduplicates and removes repositories by URI', () => {
		const repository = URI.file('/tmp/repository');
		const model = new RepositoryCatalogModel();

		model.add({ uri: repository, availability: 'missing' });
		model.add({ uri: repository, availability: 'ready' });

		assert.strictEqual(model.entries.length, 1);
		assert.strictEqual(model.entries[0].availability, 'ready');
		assert.strictEqual(model.remove(repository), true);
		assert.strictEqual(model.remove(repository), false);
		assert.deepStrictEqual(model.entries, []);
	});

	test('recovers from invalid persisted data', () => {
		assert.deepStrictEqual(RepositoryCatalogModel.restore('{').entries, []);
		assert.deepStrictEqual(RepositoryCatalogModel.restore(JSON.stringify({ version: 2, repositories: [] })).entries, []);
	});

	test('distinguishes ready, missing, and non-repository folders', async () => {
		const repository = URI.file('/tmp/repository');

		assert.strictEqual(await getRepositoryAvailability(repository, async resource => resource.path === repository.path), 'notRepository');
		assert.strictEqual(await getRepositoryAvailability(repository, async () => false), 'missing');
		assert.strictEqual(await getRepositoryAvailability(repository, async () => true), 'ready');
	});
});

suite('Canonical Configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('serializes deterministic human-readable configuration', () => {
		const serialized = serializeCanonicalConfiguration({
			version: 1,
			scope: 'global',
			skills: {
				'zeta-skill': { activation: 'off' },
				'alpha-skill': { activation: 'on' },
			},
			integrations: {},
		});

		assert.strictEqual(serialized, [
			'{',
			'\t"version": 1,',
			'\t"scope": "global",',
			'\t"skills": {',
			'\t\t"alpha-skill": {',
			'\t\t\t"activation": "on"',
			'\t\t},',
			'\t\t"zeta-skill": {',
			'\t\t\t"activation": "off"',
			'\t\t}',
			'\t},',
			'\t"integrations": {}',
			'}',
			'',
		].join('\n'));
	});

	test('keeps repository configuration portable', () => {
		const serialized = serializeCanonicalConfiguration(createCanonicalConfiguration('repository'));

		assert.strictEqual(serialized.includes('/Users/'), false);
		assert.strictEqual(serialized.includes('secret'), false);
		assert.strictEqual(serialized.includes('cache'), false);
		assert.strictEqual(serialized.includes('health'), false);
		assert.strictEqual(parseCanonicalConfiguration(serialized, 'repository').scope, 'repository');
	});

	test('rejects non-canonical and sensitive fields', () => {
		assert.throws(
			() => parseCanonicalConfiguration(JSON.stringify({
				...createCanonicalConfiguration('global'),
				secrets: { token: 'value' },
			})),
			/unsupported fields: secrets/
		);
		assert.throws(
			() => parseCanonicalConfiguration(JSON.stringify({
				...createCanonicalConfiguration('global'),
				skills: {
					'unsafe-skill': {
						activation: 'on',
						machinePath: '/tmp/unsafe',
					},
				},
			})),
			/unsupported fields: machinePath/
		);
	});

	test('rejects a document written to the wrong scope', () => {
		const serialized = serializeCanonicalConfiguration(createCanonicalConfiguration('global'));
		assert.throws(
			() => parseCanonicalConfiguration(serialized, 'repository'),
			/Expected repository configuration/
		);
	});

	test('validates portable Integration activation and client selection', () => {
		const configuration = parseCanonicalConfiguration(JSON.stringify({
			...createCanonicalConfiguration('repository'),
			integrations: {
				'local-tools': {
					activation: 'off',
					clients: ['codex', 'cursor'],
					connection: 'github:123:machine-reference',
				},
			},
		}), 'repository');
		assert.deepStrictEqual(configuration.integrations['local-tools'], {
			activation: 'off',
			clients: ['codex', 'cursor'],
			connection: 'github:123:machine-reference',
		});
		assert.throws(
			() => parseCanonicalConfiguration(JSON.stringify({
				...createCanonicalConfiguration('repository'),
				integrations: {
					'local-tools': { clients: ['cursor', 'cursor'] },
				},
			})),
			/unique supported client IDs/
		);
		assert.throws(
			() => parseCanonicalConfiguration(JSON.stringify({
				...createCanonicalConfiguration('repository'),
				integrations: {
					'local-tools': { connection: '/Users/example/secret' },
				},
			})),
			/must be an opaque Connection ID/
		);
	});
});

suite('Skill Management', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const globalSkill: ICanonicalSkillDefinition = {
		id: 'review',
		name: 'Review',
		description: 'Review repository changes.',
		origin: 'global',
		resource: URI.file('/global/skills/review/SKILL.md'),
	};
	const repositorySkill: ICanonicalSkillDefinition = {
		id: 'release',
		name: 'Release',
		description: 'Prepare a release.',
		origin: 'repository',
		resource: URI.file('/repository/.repobud/skills/release/SKILL.md'),
	};

	test('groups effective skills using repository override precedence', () => {
		const sections = resolveEffectiveSkills(
			[globalSkill, repositorySkill],
			{ review: { activation: 'off' } },
			{ review: { activation: 'on' }, release: { activation: 'off' } }
		);

		assert.deepStrictEqual(sections.enabled.map(skill => skill.id), ['review']);
		assert.deepStrictEqual(sections.available.map(skill => skill.id), ['release']);
		assert.strictEqual(sections.enabled[0].activationSource, 'repository');
		assert.strictEqual(sections.enabled[0].repositoryOverride, 'on');
		assert.deepStrictEqual(sections.enabled[0].origins, ['global']);
		assert.deepStrictEqual(sections.available[0].origins, ['repository']);
	});

	test('uses global defaults when the repository override is removed', () => {
		const sections = resolveEffectiveSkills(
			[globalSkill],
			{ review: { activation: 'off' } },
			{}
		);

		assert.strictEqual(sections.available[0].repositoryOverride, 'inherit');
		assert.strictEqual(sections.available[0].activationSource, 'global');
	});

	test('reports conflicting identities instead of shadowing them', () => {
		const repositoryConflict: ICanonicalSkillDefinition = {
			...globalSkill,
			name: 'Repository Review',
			origin: 'repository',
			resource: URI.file('/repository/.repobud/skills/review/SKILL.md'),
		};
		const sections = resolveEffectiveSkills([globalSkill, repositoryConflict], {}, {});

		assert.deepStrictEqual(sections.enabled, []);
		assert.deepStrictEqual(sections.available, []);
		assert.strictEqual(sections.needsAttention[0].id, 'review');
		assert.deepStrictEqual(sections.needsAttention[0].origins, ['repository', 'global']);
		assert.match(sections.needsAttention[0].issue ?? '', /Conflicting canonical definitions/);
	});

	test('reports activation entries without definitions', () => {
		const sections = resolveEffectiveSkills([], {}, { missing: { activation: 'on' } });

		assert.strictEqual(sections.needsAttention[0].id, 'missing');
		assert.deepStrictEqual(sections.needsAttention[0].origins, ['repository']);
		assert.match(sections.needsAttention[0].issue ?? '', /No canonical definition/);
	});
});

suite('MCP Integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const localResource: ICanonicalMcpDefinitionResource = {
		id: 'local-tools',
		origin: 'global',
		resource: URI.file('/global/integrations/local-tools.json'),
		definition: {
			version: 1,
			id: 'local-tools',
			name: 'Local tools',
			description: 'Local development tools.',
			transport: {
				type: 'stdio',
				command: 'node',
				args: ['server.mjs'],
			},
		},
	};
	const remoteResource: ICanonicalMcpDefinitionResource = {
		id: 'remote-docs',
		origin: 'repository',
		resource: URI.file('/repository/.repobud/integrations/remote-docs.json'),
		definition: {
			version: 1,
			id: 'remote-docs',
			name: 'Remote docs',
			description: 'Remote documentation tools.',
			transport: {
				type: 'http',
				url: 'https://example.com/mcp',
			},
		},
	};

	test('keeps stdio and HTTP definitions distinct and portable', () => {
		const local = parseCanonicalMcpDefinition(serializeCanonicalMcpDefinition(localResource.definition!));
		const remote = parseCanonicalMcpDefinition(serializeCanonicalMcpDefinition({
			...remoteResource.definition!,
			connection: { provider: 'github' },
		}));

		assert.strictEqual(local.transport.type, 'stdio');
		assert.strictEqual(remote.transport.type, 'http');
		assert.deepStrictEqual(remote.connection, { provider: 'github' });
		assert.doesNotMatch(serializeCanonicalMcpDefinition(local), /token|secret|header/i);
	});

	test('rejects credentials and shell-like extension fields', () => {
		assert.throws(
			() => parseCanonicalMcpDefinition(JSON.stringify({
				...remoteResource.definition,
				transport: {
					type: 'http',
					url: 'https://example.com/mcp',
					headers: { Authorization: 'Bearer secret' },
				},
			})),
			/unsupported fields: headers/
		);
		assert.throws(
			() => parseCanonicalMcpDefinition(JSON.stringify({
				...localResource.definition,
				transport: {
					type: 'stdio',
					command: 'node',
					args: [],
					env: { TOKEN: 'secret' },
				},
			})),
			/unsupported fields: env/
		);
		assert.throws(
			() => parseCanonicalMcpDefinition(JSON.stringify({
				...localResource.definition,
				transport: {
					type: 'stdio',
					command: 'node',
					args: ['server.js', '--token=literal-secret'],
				},
			})),
			/must not contain credential/
		);
		assert.throws(
			() => parseCanonicalMcpDefinition(JSON.stringify({
				...remoteResource.definition,
				transport: {
					type: 'http',
					url: 'https://example.com/mcp?token=literal-secret',
				},
			})),
			/must not contain credentials, query parameters, or fragments/
		);
		assert.throws(
			() => parseCanonicalMcpDefinition(JSON.stringify({
				...remoteResource.definition,
				connection: { provider: 'unsupported', token: 'secret' },
			})),
			/unsupported fields: token/
		);
	});

	test('resolves repository activation and client overrides independently', () => {
		const sections = resolveEffectiveMcpIntegrations(
			[localResource, remoteResource],
			{
				'local-tools': { activation: 'off', clients: ['codex'] },
				'remote-docs': { activation: 'on', clients: ['claude-code'] },
			},
			{
				'local-tools': { activation: 'on', clients: ['cursor'] },
				'remote-docs': { activation: 'off' },
			}
		);

		assert.deepStrictEqual(sections.enabled.map(integration => integration.id), ['local-tools']);
		assert.deepStrictEqual(sections.enabled[0].clients, ['cursor']);
		assert.deepStrictEqual(sections.available.map(integration => integration.id), ['remote-docs']);
		assert.deepStrictEqual(sections.available[0].clients, ['claude-code']);
	});

	test('keeps disabled definitions installed and reports missing definitions', () => {
		const sections = resolveEffectiveMcpIntegrations(
			[localResource],
			{ 'local-tools': { activation: 'off', clients: ['codex'] } },
			{ missing: { activation: 'on' } },
		);

		assert.strictEqual(sections.available[0].definitionResource?.fsPath, '/global/integrations/local-tools.json');
		assert.strictEqual(sections.needsAttention[0].id, 'missing');
		assert.match(sections.needsAttention[0].issue ?? '', /No canonical MCP definition/);
	});

	test('projects a canonical definition into Claude project configuration without clobbering other entries', () => {
		const definition = remoteResource.definition!;
		const existing = JSON.stringify({
			projectSetting: true,
			mcpServers: {
				other: { type: 'stdio', command: 'other' },
			},
		});

		assert.strictEqual(inspectClaudeMcpProjection(existing, definition), 'missing');
		const output = projectClaudeMcpDefinition(existing, definition);
		assert.strictEqual(inspectClaudeMcpProjection(output, definition), 'projected');
		const parsed = JSON.parse(output);
		assert.strictEqual(parsed.projectSetting, true);
		assert.deepStrictEqual(parsed.mcpServers.other, { type: 'stdio', command: 'other' });
		assert.deepStrictEqual(parsed.mcpServers['remote-docs'], {
			type: 'http',
			url: 'https://example.com/mcp',
		});
	});

	test('blocks replacement of an existing Claude project entry until explicitly requested', () => {
		const definition = localResource.definition!;
		const existing = JSON.stringify({
			mcpServers: {
				'local-tools': { type: 'stdio', command: 'custom' },
			},
		});

		assert.strictEqual(inspectClaudeMcpProjection(existing, definition), 'conflict');
		assert.throws(
			() => projectClaudeMcpDefinition(existing, definition),
			/differs from the canonical definition/
		);
		assert.strictEqual(
			inspectClaudeMcpProjection(projectClaudeMcpDefinition(existing, definition, true), definition),
			'projected'
		);
	});
});

suite('Plugin Package', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const manifest = {
		schemaVersion: 1,
		id: 'review-tools',
		name: 'Review Tools',
		version: '1.2.3',
		license: 'MIT',
		skills: ['skills/review'],
		integrations: ['integrations/issues.json'],
		scripts: ['scripts/check.sh'],
		connections: [{ provider: 'github' }],
	};

	test('parses a portable authority inventory', () => {
		const parsed = parsePluginPackageManifest(JSON.stringify(manifest));
		assert.strictEqual(parsed.id, 'review-tools');
		assert.deepStrictEqual(parsed.skills, ['skills/review']);
		assert.deepStrictEqual(parsed.integrations, ['integrations/issues.json']);
		assert.deepStrictEqual(parsed.scripts, ['scripts/check.sh']);
		assert.deepStrictEqual(parsed.connections, [{ provider: 'github' }]);
	});

	test('rejects traversal, unsupported fields, and duplicate requirements', () => {
		assert.throws(
			() => parsePluginPackageManifest(JSON.stringify({
				...manifest,
				skills: ['../outside'],
			})),
			/unsafe relative path/
		);
		assert.throws(
			() => parsePluginPackageManifest(JSON.stringify({
				...manifest,
				postinstall: 'scripts/check.sh',
			})),
			/unsupported fields: postinstall/
		);
		assert.throws(
			() => parsePluginPackageManifest(JSON.stringify({
				...manifest,
				connections: [{ provider: 'github' }, { provider: 'github' }],
			})),
			/duplicate providers/
		);
	});

	test('keeps Plugin disablement and executable trust separate from capability activation', () => {
		const skillDefinition: ICanonicalSkillDefinition = {
			id: 'review',
			name: 'Review',
			description: 'Review changes.',
			origin: 'plugin',
			resource: URI.file('/plugins/review-tools/skills/review/SKILL.md'),
			plugin: { id: 'review-tools', enabled: false, trusted: true },
		};
		const disabledSkills = resolveEffectiveSkills(
			[skillDefinition],
			{ review: { activation: 'on' } },
			{ review: { activation: 'on' } }
		);
		assert.strictEqual(disabledSkills.available[0].activationSource, 'plugin');
		assert.strictEqual(disabledSkills.available[0].repositoryOverride, 'on');

		const untrustedSkills = resolveEffectiveSkills([{
			...skillDefinition,
			plugin: { id: 'review-tools', enabled: true, trusted: false },
		}], {}, {});
		assert.match(untrustedSkills.needsAttention[0].issue ?? '', /untrusted executable content/);

		const integration = resolveEffectiveMcpIntegrations([{
			id: 'issues',
			origin: 'plugin',
			resource: URI.file('/plugins/review-tools/integrations/issues.json'),
			definition: {
				version: 1,
				id: 'issues',
				name: 'Issues',
				description: 'Issue tools.',
				transport: { type: 'http', url: 'https://example.com/mcp' },
			},
			plugin: { id: 'review-tools', enabled: false, trusted: true },
		}], { issues: { activation: 'on' } }, {});
		assert.strictEqual(integration.available[0].activation, 'off');
		assert.strictEqual(integration.available[0].origins[0], 'plugin');
	});
});
