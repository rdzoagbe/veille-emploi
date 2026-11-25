import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir:'./tests/ui', use:{...devices['Pixel 7'],baseURL:'http://127.0.0.1:4173'}, webServer:{command:'node tests/serve.js',url:'http://127.0.0.1:4173',reuseExistingServer:false} });
