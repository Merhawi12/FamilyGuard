import { secureStoreStub } from './platform.mjs';

export const getItemAsync = secureStoreStub.getItemAsync;
export const setItemAsync = secureStoreStub.setItemAsync;
export const deleteItemAsync = secureStoreStub.deleteItemAsync;
export default secureStoreStub;
