import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 미리보기(로컬)에서 터널 주소로 접속했을 때 서버 액션이 막히지 않아야 한다.
 *
 * 실제로 있었던 일
 * ----------------
 * Next 는 서버 액션 요청의 Origin 과 Host 가 다르면 **500 으로 거부**한다.
 * 터널을 거치면 이 둘이 어긋날 수 있어 예외 설정(serverActions.allowedOrigins)이 필요했고,
 * 실제로 넣어 두었다. 그런데 그 설정을 `NODE_ENV !== 'production'` 으로 감싸 두었다.
 *
 * 로컬 미리보기(1_미리보기실행.bat)는 개발 서버가 아니라 **프로덕션 빌드로 뜬다.**
 * 그래서 예외가 정작 필요한 자리에서 통째로 꺼져 있었고,
 * [테스트 후원 보내기]를 눌러도 **아무 문구 없이** 실패했다.
 * (거부는 화면에 표시되지 않는다 — 그래서 원인을 찾는 데 매번 오래 걸렸다)
 *
 * 설정 파일을 문자열로 검사한다. next.config.ts 는 Next 가 자체 로더로 읽으므로
 * 테스트에서 그대로 import 할 수 없다.
 */

const ROOT = process.cwd();
const config = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');
const preview = readFileSync(path.join(ROOT, 'tools', 'preview.mjs'), 'utf8');

describe('미리보기 접속 출처 설정', () => {
  it('터널 예외가 NODE_ENV 만으로 결정되지 않는다', () => {
    // 이 조건만으로 감싸면 프로덕션 빌드로 뜨는 로컬 미리보기에서 예외가 꺼진다.
    expect(config).toContain('TORNADO_LOCAL_PREVIEW');
    expect(config).toContain('isLocalPreview');
  });

  it('로컬 미리보기 표시가 있으면 예외를 켠다', () => {
    expect(config).toMatch(/allowTunnelOrigins\s*=\s*isLocalPreview\s*\|\|/);
    expect(config).toMatch(/allowTunnelOrigins\s*\n?\s*\?\s*\{/);
  });

  it('미리보기 실행기가 빌드와 실행 양쪽에 그 표시를 넣는다', () => {
    // previewEnv 는 build 와 start 양쪽 spawn 에 함께 넘어간다.
    expect(preview).toContain("TORNADO_LOCAL_PREVIEW: '1'");
    const envBlock = preview.slice(preview.indexOf('const previewEnv'), preview.indexOf('Object.assign(process.env'));
    expect(envBlock).toContain('TORNADO_LOCAL_PREVIEW');
  });

  it('터널 주소는 실행할 때마다 바뀌므로 와일드카드로 둔다', () => {
    expect(config).toContain("'*.trycloudflare.com'");
    // 특정 호스트를 박아 두면 터널을 다시 띄울 때마다 또 막힌다.
    expect(config).not.toMatch(/['"][a-z0-9-]+\.trycloudflare\.com['"]/);
  });

  it('추가 주소를 환경변수로 넣을 수 있다', () => {
    expect(config).toContain('PREVIEW_ALLOWED_ORIGINS');
  });

  it('화면 데이터 요청과 서버 액션이 같은 목록을 쓴다', () => {
    // 예전에는 allowedDevOrigins 에만 터널을 넣고 서버 액션 쪽을 빠뜨려 절반만 열렸다.
    expect(config).toContain('allowedDevOrigins: TUNNEL_ORIGINS');
    expect(config).toContain('allowedOrigins: TUNNEL_ORIGINS');
  });
});

describe('미리보기 안내', () => {
  it('프로덕션 빌드라 다시 실행해야 반영된다는 것을 알려 준다', () => {
    // 이걸 모르면 "고쳤는데 화면은 그대로" 로 헤맨다.
    expect(preview).toContain('다시 실행해야 반영됩니다');
  });

  it('재사용하는 빌드의 시각을 표시한다', () => {
    expect(preview).toContain('빌드 시각');
  });
});
