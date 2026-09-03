'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import type { AdminActionState } from '@/components/admin/state';
import { run, text, optText, int, bool, enumValue, requiredId, optDate, optEndDate } from './shared';

/**
 * 배너 / 공지·FAQ 관리 액션.
 */

/**
 * 허용 링크 형식.
 *
 * `//evil.example.com` 은 `/` 로 시작하지만 브라우저는 **프로토콜 상대 URL**(외부 절대 주소)로
 * 해석한다. 화면 안내는 "/ 로 시작하는 내부 경로만 허용"이라고 하는데 실제로는 외부
 * 리다이렉트가 가능했다. 슬래시 두 개로 시작하는 경로를 명시적으로 배제한다.
 */
const SAFE_URL = /^(https?:\/\/|\/(?!\/))[^\s"'<>]*$/;

function checkUrl(value: string | null, label: string): string | null {
  if (!value) return null;
  if (!SAFE_URL.test(value)) throw new Error(`${label}은(는) http(s) 주소 또는 / 로 시작하는 경로여야 합니다.`);
  return value;
}

// =========================================================== 배너

export async function saveBanner(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = optText(fd, 'id');
    const position = text(fd, 'position');
    const title = text(fd, 'title');
    if (!position) throw new Error('노출 위치를 입력해 주세요.');
    if (title.length < 2) throw new Error('배너 제목을 2자 이상 입력해 주세요.');

    const data = {
      position,
      title,
      subtitle: optText(fd, 'subtitle'),
      imageUrl: checkUrl(optText(fd, 'imageUrl'), '이미지 주소'),
      linkUrl: checkUrl(optText(fd, 'linkUrl'), '연결 주소'),
      sortOrder: int(fd, 'sortOrder', { min: -999, max: 999, label: '정렬 순서' }),
      active: bool(fd, 'active'),
      startsAt: optDate(fd, 'startsAt', '노출 시작일'),
      // 종료일은 '그날까지 보인다'는 뜻이므로 그날 24시로 저장한다.
      endsAt: optEndDate(fd, 'endsAt', '노출 종료일'),
    };
    if (data.startsAt && data.endsAt && data.startsAt > data.endsAt) {
      throw new Error('노출 시작일이 종료일보다 늦을 수 없습니다.');
    }

    if (id) {
      const before = await prisma.banner.findUnique({ where: { id } });
      if (!before) throw new Error('배너를 찾을 수 없습니다.');
      await prisma.banner.update({ where: { id }, data });
      await writeAudit({
        adminUserId: admin.id,
        action: 'BANNER_UPDATE',
        targetType: 'Banner',
        targetId: id,
        before: { position: before.position, title: before.title, active: before.active, sortOrder: before.sortOrder },
        after: data,
      });
      revalidatePath('/admin/banners');
      return '배너를 저장했습니다.';
    }

    const created = await prisma.banner.create({ data: { id: newId(), ...data } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'BANNER_CREATE',
      targetType: 'Banner',
      targetId: created.id,
      after: data,
    });
    revalidatePath('/admin/banners');
    return '배너를 등록했습니다.';
  });
}

export async function deleteBanner(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = requiredId(fd, 'id', '배너');
    const before = await prisma.banner.findUnique({ where: { id } });
    if (!before) throw new Error('배너를 찾을 수 없습니다.');

    await prisma.banner.delete({ where: { id } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'BANNER_DELETE',
      targetType: 'Banner',
      targetId: id,
      before: { position: before.position, title: before.title },
    });
    revalidatePath('/admin/banners');
    return '배너를 삭제했습니다.';
  });
}

// =========================================================== 공지 / FAQ

export async function saveContentPost(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = optText(fd, 'id');
    const type = enumValue(fd, 'type', ['NOTICE', 'FAQ'] as const, '유형');
    const title = text(fd, 'title');
    const body = text(fd, 'body');
    if (title.length < 2) throw new Error('제목을 2자 이상 입력해 주세요.');
    if (body.length < 5) throw new Error('본문을 5자 이상 입력해 주세요.');

    const data = {
      type,
      title,
      body,
      category: optText(fd, 'category'),
      pinned: bool(fd, 'pinned'),
      published: bool(fd, 'published'),
      sortOrder: int(fd, 'sortOrder', { min: -999, max: 999, label: '정렬 순서' }),
    };

    if (id) {
      const before = await prisma.contentPost.findUnique({ where: { id } });
      if (!before) throw new Error('게시글을 찾을 수 없습니다.');
      await prisma.contentPost.update({ where: { id }, data });
      await writeAudit({
        adminUserId: admin.id,
        action: 'CONTENT_POST_UPDATE',
        targetType: 'ContentPost',
        targetId: id,
        before: { type: before.type, title: before.title, published: before.published, pinned: before.pinned },
        after: { type: data.type, title: data.title, published: data.published, pinned: data.pinned },
      });
      revalidatePath('/admin/contents');
      return '게시글을 저장했습니다.';
    }

    const created = await prisma.contentPost.create({ data: { id: newId(), ...data } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'CONTENT_POST_CREATE',
      targetType: 'ContentPost',
      targetId: created.id,
      after: { type: data.type, title: data.title, published: data.published },
    });
    revalidatePath('/admin/contents');
    return '게시글을 등록했습니다.';
  });
}

export async function deleteContentPost(_prev: AdminActionState, fd: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const id = requiredId(fd, 'id', '게시글');
    const before = await prisma.contentPost.findUnique({ where: { id } });
    if (!before) throw new Error('게시글을 찾을 수 없습니다.');

    await prisma.contentPost.delete({ where: { id } });
    await writeAudit({
      adminUserId: admin.id,
      action: 'CONTENT_POST_DELETE',
      targetType: 'ContentPost',
      targetId: id,
      before: { type: before.type, title: before.title },
    });
    revalidatePath('/admin/contents');
    return '게시글을 삭제했습니다.';
  });
}
