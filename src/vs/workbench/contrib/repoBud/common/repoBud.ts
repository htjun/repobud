/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ViewContainerLocation } from '../../../common/views.js';

export const REPOBUD_VIEW_CONTAINER_IDS = {
	sourceControl: 'workbench.view.scm',
	skills: 'workbench.view.repoBud.skills',
	integrations: 'workbench.view.repoBud.integrations',
} as const;

export const REPOBUD_VIEW_IDS = {
	skills: 'workbench.repoBud.skills',
	integrations: 'workbench.repoBud.integrations',
} as const;

const allowedPrimaryViewContainerIds = new Set<string>(Object.values(REPOBUD_VIEW_CONTAINER_IDS));

export function isRepoBudViewContainerAllowed(id: string, location: ViewContainerLocation): boolean {
	return location === ViewContainerLocation.Sidebar && allowedPrimaryViewContainerIds.has(id);
}
