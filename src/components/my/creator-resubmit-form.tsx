'use client';

import * as React from 'react';
import { Send } from '@/components/brand/icons';
import { Button, Card, CardTitle, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { resubmitCreatorApplication, type ResubmitState } from '@/app/actions/creator-apply';
import { ChannelRowsEditor, type ChannelRowValue } from '@/components/public/channel-rows-editor';
import { VIDEO_CATEGORIES } from '@/lib/video-hub';

const initial: ResubmitState = { ok: false };

/** 보완요청·반려 후 신청서를 고쳐 다시 제출 */
export function CreatorResubmitForm({
  displayName,
  description,
  contentCategory,
  channels,
  primaryIndex,
}: {
  displayName: string;
  description: string | null;
  contentCategory: string | null;
  channels: ChannelRowValue[];
  primaryIndex: number;
}) {
  const [state, action, pending] = React.useActionState(resubmitCreatorApplication, initial);
  return (
    <form action={action} className="space-y-4">
      <Card className="space-y-4">
        <CardTitle>신청 내용 수정</CardTitle>
        <Field label="표시명" required>
          <Input name="displayName" required maxLength={30} defaultValue={displayName} />
        </Field>
        <Field label="활동 카테고리">
          <Select name="contentCategory" defaultValue={contentCategory ?? ''}>
            <option value="">선택 안 함</option>
            {VIDEO_CATEGORIES.filter((c) => c.slug !== 'all' && c.slug !== 'donaido').map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="소개" hint="300자 이내">
          <Textarea name="description" rows={3} maxLength={300} defaultValue={description ?? ''} />
        </Field>
      </Card>
      <Card className="space-y-3">
        <CardTitle>운영 채널</CardTitle>
        <ChannelRowsEditor initial={channels} initialPrimary={primaryIndex} />
      </Card>
      {state.message ? <Notice tone={state.ok ? 'success' : 'warning'}>{state.message}</Notice> : null}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '제출 중' : '다시 제출하기'}
        <Send size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}
