/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IRepositoryContextMcpHealthService,
	REPOSITORY_CONTEXT_MCP_HEALTH_CHANNEL,
} from '../../../../platform/repositoryContext/common/mcpHealth.js';

registerMainProcessRemoteService(
	IRepositoryContextMcpHealthService,
	REPOSITORY_CONTEXT_MCP_HEALTH_CHANNEL
);
