import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // DB 를 공유하므로 파일 간 병렬 실행을 막는다.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    // .tsx 도 받는다. 화면 컴포넌트를 실제로 그려 보고 문구·버튼을 확인하는
    // 렌더 테스트가 있다(예: 감사 문자 편집기).
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
