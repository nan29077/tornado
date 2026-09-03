import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 로컬 검수용 스크래치 디렉터리. 빌드 산출물(next-verify 등)이 들어 있어
    // 그냥 두면 소스와 무관한 lint 오류가 수백 건 쏟아진다.
    "tmp/**",
    // Prisma 가 생성하는 클라이언트. 손으로 고치는 파일이 아니다.
    "src/generated/**",
  ]),
]);

export default eslintConfig;
