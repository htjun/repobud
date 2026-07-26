/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const REPOBUD_MCP_HEALTH_CHANNEL = 'repoBudMcpHealth';

export interface IMcpStdioHealthTransport {
	readonly type: 'stdio';
	readonly command: string;
	readonly args: readonly string[];
}

export interface IMcpHttpHealthTransport {
	readonly type: 'http';
	readonly url: string;
}

export type IMcpHealthTransport = IMcpStdioHealthTransport | IMcpHttpHealthTransport;

export interface IMcpHealthRequest {
	readonly id: string;
	readonly transport: IMcpHealthTransport;
	readonly repository?: URI;
}

export interface IMcpHealthResult {
	readonly state: 'healthy' | 'unreachable';
	readonly checkedAt: number;
	readonly protocolVersion?: string;
	readonly capabilities: readonly string[];
	readonly detail?: string;
}

export const IRepoBudMcpHealthService =
	createDecorator<IRepoBudMcpHealthService>('repoBudMcpHealthService');

/**
 * Checks MCP server health without persisting runtime output.
 */
export interface IRepoBudMcpHealthService {
	readonly _serviceBrand: undefined;

	check(request: IMcpHealthRequest): Promise<IMcpHealthResult>;
}
