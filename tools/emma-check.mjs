#!/usr/bin/env node
/**
 * EMMA 연동 점검 도구.
 *
 *   node tools/emma-check.mjs
 *
 * 하는 일
 *  1) EMMA DB 접속 확인
 *  2) 이번 달·지난 달 MO 테이블과 발송 큐 존재 확인
 *  3) 최근 수신 문자 10건을 **번호 분해 결과와 함께** 출력
 *  4) 우리 DB 의 배정 번호와 대조해 "이 문자가 어느 크리에이터로 갈지" 미리 보여 준다
 *  5) 발송 큐에 밀려 있는 문자 확인
 *
 * 왜 필요한가
 * -----------
 * 계약 후 가장 먼저 확인해야 하는 것이 **"1688-□□□□-XXXX 로 문자를 보내면 뒤 4자리가
 * emo_recipient 로 오는가"** 다. 이 값이 어디에 담겨 오는지는 통신망 등록 방식에 달려 있어
 * 문서로는 확정할 수 없고 실제 수신 1건을 봐야 안다. 이 도구가 그 답을 바로 보여 준다.
 *
 * 개인정보 보호
 *  발신번호는 항상 마스킹해 출력한다. 본문은 앞 20자만 보여 준다.
 */

import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function ymKst(date = new Date(), monthDelta = 0) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const d = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + monthDelta, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function digitsOnly(v) {
  return String(v ?? '').replace(/\D/g, '');
}

/** src/server/emma/number.ts 의 restoreMoNumber 와 같은 규칙이어야 한다. */
function restoreMoNumber(moRecipient, emoRecipient) {
  const base = digitsOnly(moRecipient);
  const ext = digitsOnly(emoRecipient);
  if (!ext) return base;
  if (!base) return ext;
  if (ext.startsWith(base)) return ext;
  return `${base}${ext}`;
}

function maskPhone(v) {
  const p = digitsOnly(v);
  if (p.length < 9) return '***';
  return `${p.slice(0, 3)}-****-${p.slice(-4)}`;
}

function line(char = '─', n = 78) {
  return char.repeat(n);
}

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) AS ok`,
    [name],
  );
  return r.rows[0]?.ok === true;
}

async function main() {
  const emmaUrl = (process.env.EMMA_DB_URL ?? '').trim() || process.env.DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  const baseNumber = digitsOnly(process.env.EMMA_MO_BASE_NUMBER);

  if (!emmaUrl) {
    console.error('EMMA_DB_URL 도 DATABASE_URL 도 설정되어 있지 않습니다. .env 를 확인해 주세요.');
    process.exit(1);
  }

  console.log(line('='));
  console.log(' EMMA 연동 점검');
  console.log(line('='));
  console.log(` EMMA_ENABLED        : ${process.env.EMMA_ENABLED ?? '(미설정)'}`);
  console.log(` EMMA DB             : ${emmaUrl === appUrl ? '앱과 같은 DB (분리 권장)' : '전용 DB (권장 구성)'}`);
  console.log(` EMMA_MO_BASE_NUMBER : ${baseNumber || '(미설정 — 계약 후 반드시 지정)'}`);
  console.log(` MT_PROVIDER         : ${process.env.MT_PROVIDER ?? '(미설정)'}`);
  console.log(` MT_SENDER_NUMBER    : ${process.env.MT_SENDER_NUMBER || process.env.MT_FROM_NUMBER || '(미설정)'}`);
  console.log(` EMMA_ID             : ${process.env.EMMA_ID ? `${process.env.EMMA_ID} (이중화 사용)` : '(비어 있음 — 정상)'}`);
  console.log('');

  const client = new Client({ connectionString: emmaUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (e) {
    console.error(`[실패] EMMA DB 에 접속할 수 없습니다: ${e.message}`);
    process.exit(1);
  }

  const suffixes = [ymKst(), ymKst(new Date(), -1)];

  console.log(line());
  console.log(' 1. 테이블 확인');
  console.log(line());
  for (const s of suffixes) {
    const name = `em_mo_log_${s}`;
    const ok = await tableExists(client, name);
    if (!ok) {
      console.log(`  ${name.padEnd(24)} 없음 (그 달 수신이 아직 없거나 EMMA 미설치)`);
      continue;
    }
    const c = await client.query(
      `SELECT msg_status, COUNT(*)::int AS n FROM ${name} GROUP BY msg_status ORDER BY msg_status`,
    );
    const summary = c.rows.map((r) => `${r.msg_status.trim() || "' '"}:${r.n}`).join('  ') || '(비어 있음)';
    console.log(`  ${name.padEnd(24)} 있음   상태별 건수 → ${summary}`);
  }
  const mtOk = await tableExists(client, 'em_smt_tran');
  console.log(`  ${'em_smt_tran'.padEnd(24)} ${mtOk ? '있음' : '없음 (SMS MT 프로시저 미설치)'}`);
  console.log('');
  console.log('  상태값 의미: 3=EMMA 가 넣은 신규 / 2=토네이도가 처리 중 / 9=토네이도 처리 완료');
  console.log('');

  console.log(line());
  console.log(' 2. 최근 수신 문자 — 번호가 어떻게 나뉘어 오는지 확인');
  console.log(line());

  let sawAny = false;
  for (const s of suffixes) {
    const name = `em_mo_log_${s}`;
    if (!(await tableExists(client, name))) continue;
    const r = await client.query(
      `SELECT mo_key, mo_recipient, emo_recipient, mo_originator, content, msg_status, date_mo
         FROM ${name} ORDER BY date_mo DESC LIMIT 10`,
    );
    for (const row of r.rows) {
      sawAny = true;
      const full = restoreMoNumber(row.mo_recipient, row.emo_recipient);
      const sub = full.length > 4 ? full.slice(-4) : '';
      const base = full.length > 4 ? full.slice(0, -4) : full;
      console.log('');
      console.log(`  mo_key        : ${row.mo_key}`);
      console.log(`  mo_recipient  : ${JSON.stringify(row.mo_recipient)}`);
      console.log(`  emo_recipient : ${JSON.stringify(row.emo_recipient)}   ← 여기에 뒤 4자리가 오는지가 핵심`);
      console.log(`  복원 결과     : ${full}   (대표번호 ${base} + 서브번호 ${sub || '없음'})`);
      console.log(`  발신          : ${maskPhone(row.mo_originator)}`);
      console.log(`  본문          : ${String(row.content ?? '').slice(0, 20)}${(row.content ?? '').length > 20 ? '…' : ''}`);
      console.log(`  상태 / 시각   : ${String(row.msg_status).trim()} / ${row.date_mo?.toISOString?.() ?? row.date_mo}`);

      if (baseNumber && base !== baseNumber) {
        console.log(`  ⚠ 대표번호가 설정값(${baseNumber})과 다릅니다 → 이 문자는 처리되지 않습니다.`);
      }
    }
  }
  if (!sawAny) {
    console.log('');
    console.log('  수신 기록이 없습니다. 배정된 번호로 테스트 문자를 1건 보낸 뒤 다시 실행해 주세요.');
  }
  console.log('');

  console.log(line());
  console.log(' 3. 우리 DB 의 번호 배정과 대조');
  console.log(line());
  if (!appUrl) {
    console.log('  DATABASE_URL 이 없어 대조를 건너뜁니다.');
  } else {
    const app = emmaUrl === appUrl ? client : new Client({ connectionString: appUrl, connectionTimeoutMillis: 5000 });
    if (app !== client) await app.connect();
    try {
      const r = await app.query(
        `SELECT n.phone_number, n.base_number, n.sub_code, n.status, c.display_name
           FROM creator_mo_number n
           LEFT JOIN creator_profile c ON c.id = n.creator_id
          WHERE n.keyword IS NULL
          ORDER BY n.status, n.phone_number
          LIMIT 30`,
      );
      if (r.rows.length === 0) {
        console.log('  배정된 전용번호가 없습니다.');
      } else {
        console.log(`  ${'수신번호'.padEnd(16)} ${'서브'.padEnd(6)} ${'상태'.padEnd(10)} 크리에이터`);
        for (const row of r.rows) {
          console.log(
            `  ${String(row.phone_number).padEnd(16)} ${String(row.sub_code ?? '-').padEnd(6)} ` +
              `${String(row.status).padEnd(10)} ${row.display_name ?? '-'}`,
          );
        }
      }
    } catch (e) {
      console.log(`  조회 실패: ${e.message}`);
    } finally {
      if (app !== client) await app.end().catch(() => undefined);
    }
  }
  console.log('');

  if (mtOk) {
    console.log(line());
    console.log(' 4. 발송 큐 (EMMA 가 집어가지 않고 쌓여 있으면 MT 설정 문제)');
    console.log(line());
    const q = await client.query(
      `SELECT msg_status, COUNT(*)::int AS n, MIN(date_client_req) AS oldest
         FROM em_smt_tran GROUP BY msg_status ORDER BY msg_status`,
    );
    if (q.rows.length === 0) {
      console.log('  큐가 비어 있습니다.');
    } else {
      for (const row of q.rows) {
        const status = String(row.msg_status).trim();
        const note =
          status === '1'
            ? '발송 대기 — 오래 쌓여 있으면 EMMA 의 SMS MT 서비스가 꺼져 있는지 확인'
            : '';
        console.log(`  상태 ${status}: ${row.n}건  (가장 오래된 것 ${row.oldest?.toISOString?.() ?? row.oldest})  ${note}`);
      }
      const stuck = await client.query(
        `SELECT COUNT(*)::int AS n FROM em_smt_tran
          WHERE msg_status = '1' AND date_client_req < NOW() - INTERVAL '10 minutes'`,
      );
      if ((stuck.rows[0]?.n ?? 0) > 0) {
        console.log('');
        console.log(`  ⚠ 10분 넘게 발송되지 않은 문자가 ${stuck.rows[0].n}건 있습니다.`);
        console.log('    EMMA 설정(emma.cf)에서 아래가 모두 1 인지 확인하십시오:');
        console.log('      process.use.mtsender / mtreceiver / smtcollector / mtdistributor');
        console.log('    또한 em_smt_tran.emma_id 가 EMMA 설정과 다르면 영원히 발송되지 않습니다.');
      }
    }
    console.log('');
  }

  await client.end().catch(() => undefined);
  console.log(line('='));
  console.log(' 점검 완료');
  console.log(line('='));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
