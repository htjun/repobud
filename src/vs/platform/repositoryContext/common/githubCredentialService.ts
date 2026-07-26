/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface IGitHubCredentialValidation {
	readonly state: 'valid' | 'expired' | 'rejected';
	readonly accountId?: string;
	readonly accountLabel?: string;
	readonly scopes: readonly string[];
	readonly expiresAt?: number;
}

export const IGitHubCredentialService =
	createDecorator<IGitHubCredentialService>('githubCredentialService');

export interface IGitHubCredentialService {
	readonly _serviceBrand: undefined;

	validate(token: string): Promise<IGitHubCredentialValidation>;
}
