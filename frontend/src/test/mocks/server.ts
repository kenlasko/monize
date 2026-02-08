import { setupServer } from 'msw/node';
import { allHandlers } from './api';

export const server = setupServer(...allHandlers);
