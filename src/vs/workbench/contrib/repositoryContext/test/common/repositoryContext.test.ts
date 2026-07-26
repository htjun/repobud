/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ViewContainerLocation } from '../../../../common/views.js';
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
