#!/usr/bin/env node
import { ensureSearxngConfig } from '../src/lib/searxng-settings.mjs';

await ensureSearxngConfig(process.env);
