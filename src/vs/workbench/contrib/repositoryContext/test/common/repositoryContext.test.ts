/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { createCanonicalConfiguration, parseCanonicalConfiguration, serializeCanonicalConfiguration } from '../../common/canonicalConfiguration.js';
import { getRepositoryAvailability, RepositoryCatalogModel } from '../../common/repositoryCatalog.js';
import { REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS, isRepositoryContextViewContainerAllowed } from '../../common/repositoryContext.js';
import { ICanonicalSkillDefinition, resolveEffectiveSkills } from '../../common/skillManagement.js';

suite('Repository Context product composition', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('allows only the three product areas in the primary side bar', () => {
		for (const id of Object.values(REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS)) {
			assert.strictEqual(isRepositoryContextViewContainerAllowed(id, ViewContainerLocation.Sidebar), true);
			assert.strictEqual(isRepositoryContextViewContainerAllowed(id, ViewContainerLocation.Panel), false);
			assert.strictEqual(isRepositoryContextViewContainerAllowed(id, ViewContainerLocation.AuxiliaryBar), false);
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
			assert.strictEqual(isRepositoryContextViewContainerAllowed(id, ViewContainerLocation.Sidebar), false);
			assert.strictEqual(isRepositoryContextViewContainerAllowed(id, ViewContainerLocation.Panel), false);
			assert.strictEqual(isRepositoryContextViewContainerAllowed(id, ViewContainerLocation.AuxiliaryBar), false);
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
		resource: URI.file('/repository/.repository-context/skills/release/SKILL.md'),
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
			resource: URI.file('/repository/.repository-context/skills/review/SKILL.md'),
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
