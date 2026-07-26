/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { getRepositoryAvailability, RepositoryCatalogModel } from '../../common/repositoryCatalog.js';
import { REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS, isRepositoryContextViewContainerAllowed } from '../../common/repositoryContext.js';

suite('Repository Context product composition', () => {

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
