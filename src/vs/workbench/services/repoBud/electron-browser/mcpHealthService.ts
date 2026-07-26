/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IRepoBudMcpHealthService,
	REPOBUD_MCP_HEALTH_CHANNEL,
} from '../../../../platform/repoBud/common/mcpHealth.js';

registerMainProcessRemoteService(
	IRepoBudMcpHealthService,
	REPOBUD_MCP_HEALTH_CHANNEL
);
