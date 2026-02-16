import { z } from 'zod';

// Disable Zod v4 JIT compilation to avoid Function() constructor usage
// which violates Content-Security-Policy (script-src without 'unsafe-eval').
z.config({ jitless: true });
