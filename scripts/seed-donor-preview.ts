import 'dotenv/config';
import { ensureDonorPreviewSeed } from '../src/server/services/donor-preview-seed';
import { prisma } from '../src/server/db';

ensureDonorPreviewSeed()
  .then((result) => console.log('후원자 검수 데이터 준비 완료:', { samples: result.samples, creatorCode: result.creatorCode ?? null }))
  .catch((error) => { console.error((error as Error).message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
