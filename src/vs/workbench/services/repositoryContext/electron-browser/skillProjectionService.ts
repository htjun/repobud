/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IRepositoryContextSkillProjectionService,
	REPOSITORY_CONTEXT_SKILL_PROJECTION_CHANNEL,
} from '../../../../platform/repositoryContext/common/skillProjection.js';

registerMainProcessRemoteService(
	IRepositoryContextSkillProjectionService,
	REPOSITORY_CONTEXT_SKILL_PROJECTION_CHANNEL
);
