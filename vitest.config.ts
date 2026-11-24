import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  // rspack 构建期注入的 API 地址在 vitest 里也要有，否则 api/ 层一 import 就炸
  define: {
    __API_ORIGIN__: JSON.stringify('https://api.deepseek.com'),
  },
});
