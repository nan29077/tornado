'use client';

import * as React from 'react';
import { Notice } from '@/components/ui';

/**
 * 접속 주소와 서버가 인식한 주소가 어긋났을 때 알려 주는 배너.
 *
 * 왜 필요한가
 * -----------
 * Next 는 서버 액션 요청의 Origin 헤더와 Host 헤더가 다르면 **500 으로 거부**한다.
 * 터널(Cloudflare 등)을 거쳐 접속하면 이 둘이 어긋날 수 있는데, 거부되어도
 * 화면에는 **아무 문구도 뜨지 않는다.** [테스트 후원 보내기]·[설정 저장]을 눌러도
 * 아무 일도 일어나지 않는 것처럼 보일 뿐이다. 실제로 이것 때문에 "미리보기가 안 된다"는
 * 신고가 반복됐고, 원인을 찾는 데 매번 오래 걸렸다.
 *
 * 보이지 않는 실패를 보이게 만드는 것이 이 배너의 목적이다.
 * 정상일 때는 아무것도 그리지 않는다.
 */
/**
 * 브라우저 주소창의 호스트.
 *
 * effect 로 state 를 채우면 렌더가 한 번 더 돌고(연쇄 렌더 경고) 배너가 한 프레임 늦게 뜬다.
 * useSyncExternalStore 는 서버에서는 빈 값, 브라우저에서는 실제 값을 첫 렌더에 바로 준다.
 * 주소는 페이지가 살아 있는 동안 바뀌지 않으므로 구독은 아무것도 하지 않는다.
 */
const noSubscribe = () => () => {};
const readBrowserHost = () => window.location.host;
const readServerSnapshot = () => '';

export function OriginWarning({ serverHost }: { serverHost: string }) {
  const browserHost = React.useSyncExternalStore(noSubscribe, readBrowserHost, readServerSnapshot);

  if (!browserHost || !serverHost) return null;
  if (browserHost === serverHost) return null;

  return (
    <div className="mb-4">
      <Notice tone="danger" title="접속 주소가 서버가 아는 주소와 다릅니다">
        <span className="block">
          지금 보고 계신 주소는 <strong className="font-mono">{browserHost}</strong> 인데, 서버는{' '}
          <strong className="font-mono">{serverHost}</strong> 로 알고 있습니다.
        </span>
        <span className="mt-2 block">
          이 상태에서는 <strong>[테스트 후원 보내기]·[설정 저장]</strong> 같은 동작이 서버 앞단에서 거부되어,
          <strong> 아무 반응 없이 실패</strong>합니다. 미리보기에 후원 알림이나 게임이 나타나지 않는 것도 같은
          이유입니다.
        </span>
        <span className="mt-2 block">
          해결: <strong className="font-mono">http://localhost:3025</strong> 로 접속하시거나, 미리보기 서버를 다시
          시작해 주세요. (다시 시작하면 이 주소를 신뢰 목록에 넣은 설정으로 새로 빌드됩니다)
        </span>
      </Notice>
    </div>
  );
}
