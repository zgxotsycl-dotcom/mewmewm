# mewdle

slither.io 스타일의 온라인 지렁이(웜) 게임 프로토타입입니다. `express` + `socket.io` 서버가 게임 상태를 시뮬레이션하고, 클라이언트는 `Three.js`로 3D(아이소메트릭) 렌더링합니다.

## 실행

```bash
npm install
npm run dev
```

- 접속: `http://localhost:3000`
- 컨트롤: 마우스 이동(방향) / 스페이스 또는 마우스 버튼(부스트)
- 닉네임: 미입력 시 `Unknown`
- UI: 리더보드 + 미니맵(좌상단)
- 규칙: 다른 플레이어의 몸통에 머리가 닿으면 사망, 정면충돌은 더 짧은 쪽이 사망
- 봇: 서버 시작 시 기본 10마리 자동 스폰 (`src/server/server.ts`의 `BOT_COUNT`)
- 길이: 길이에 따라 지렁이 굵기/충돌 판정이 자연스럽게 증가
- 먹이: 기본 먹이 + 랜덤 클러스터 스폰으로 밀도 보강

## 스크립트

- `npm run dev`: 클라이언트(Parcel watch) + 서버(ts-node) 동시 실행
- `npm run build`: 클라이언트 정적 빌드(`dist/`)
- `npm start`: 서버 실행
- `npm run typecheck`: 타입체크(`tsc --noEmit`)
- `npm test`: 간단한 밸런스/유틸 테스트(`ts-node scripts/test.ts`)
