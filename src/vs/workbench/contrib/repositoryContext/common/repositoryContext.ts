/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ViewContainerLocation } from '../../../common/views.js';

export const REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS = {
	sourceControl: 'workbench.view.scm',
	skills: 'workbench.view.repositoryContext.skills',
	integrations: 'workbench.view.repositoryContext.integrations',
} as const;

export const REPOSITORY_CONTEXT_VIEW_IDS = {
	skills: 'workbench.repositoryContext.skills',
	integrations: 'workbench.repositoryContext.integrations',
} as const;

const allowedPrimaryViewContainerIds = new Set<string>(Object.values(REPOSITORY_CONTEXT_VIEW_CONTAINER_IDS));

export function isRepositoryContextViewContainerAllowed(id: string, location: ViewContainerLocation): boolean {
	return location === ViewContainerLocation.Sidebar && allowedPrimaryViewContainerIds.has(id);
}
