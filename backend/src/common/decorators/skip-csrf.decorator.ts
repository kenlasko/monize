import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_KEY = 'skipCsrf';
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
