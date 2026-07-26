/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IKeychainCredentialService =
	createDecorator<IKeychainCredentialService>('keychainCredentialService');

export interface IKeychainCredentialService {
	readonly _serviceBrand: undefined;

	isAvailable(): Promise<boolean>;
	get(connectionId: string): Promise<string | undefined>;
	set(connectionId: string, secret: string): Promise<void>;
	delete(connectionId: string): Promise<void>;
}
