// 1단계 탐색 스크립트 — 자격증명을 전혀 사용하지 않는다.
// 목적: 홈택스 로그인 화면에서 "금융인증서 로그인" 경로의 실제 selector/구조를 파악해서
// login-test.mjs(2단계, 실제 PIN 입력)를 추측이 아닌 관찰된 사실 기반으로 작성하기 위함.
//
// 산출물: reports/ 아래 스크린샷(.png)과 텍스트/셀렉터 덤프(.json, .txt)
// 이 파일들은 실제 화면 내용(업체명 등 개인정보는 아직 로그인 전이라 없음)을 담을 수 있으니 .gitignore 처리됨.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('reports');

async function dumpFrameInputs(frame, label) {
  const inputs = await frame.locator('input, button, a').evaluateAll((els) =>
    els.slice(0, 200).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type'),
      id: el.id || null,
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      text: (el.textContent || '').trim().slice(0, 40),
      class: el.className || null,
    }))
  );
  return { label, url: frame.url(), inputs };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const log = [];
  const step = async (name, fn) => {
    try {
      await fn();
      log.push({ step: name, ok: true });
      console.log(`[ok] ${name}`);
    } catch (err) {
      log.push({ step: name, ok: false, error: String(err) });
      console.log(`[fail] ${name}: ${err}`);
    }
  };

  await step('01-goto-home', async () => {
    await page.goto('https://www.hometax.go.kr', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT_DIR, '01-home.png'), fullPage: true });
  });

  const allFrameDumps = [];

  await step('02-find-login-entry', async () => {
    // 1차 탐색 결과 헤더의 실제 로그인 링크는 id=mf_wfHeader_group1503 (텍스트 "로그인").
    // page.getByText('로그인')는 "비회원으로 로그인 되었습니다" 상태 텍스트를 먼저 잡아버려서 id로 직접 지정.
    await page.locator('#mf_wfHeader_group1503').click({ timeout: 10000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT_DIR, '02-after-login-click.png'), fullPage: true });
  });

  await step('03-dump-main-frame-inputs', async () => {
    allFrameDumps.push(await dumpFrameInputs(page.mainFrame(), 'main'));
  });

  await step('04-dump-all-frames', async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        allFrameDumps.push(await dumpFrameInputs(frame, `iframe:${frame.name() || frame.url()}`));
      } catch (err) {
        allFrameDumps.push({ label: `iframe:${frame.url()}`, error: String(err) });
      }
    }
  });

  await step('05-find-fincert-tab', async () => {
    const fincertCandidates = page.getByText('금융인증서', { exact: false });
    const count = await fincertCandidates.count();
    log.push({ note: `'금융인증서' 텍스트 후보 ${count}개 발견 (메인 프레임 기준)` });
    if (count > 0) {
      await fincertCandidates.first().click({ timeout: 10000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(OUT_DIR, '03-fincert-tab.png'), fullPage: true });
      allFrameDumps.push(await dumpFrameInputs(page.mainFrame(), 'main-after-fincert-click'));
    } else {
      log.push({ note: '메인 프레임에서 못 찾음 — iframe 안에 있을 가능성, 04 결과 참고' });
    }
  });

  await step('06-click-gongdong-geumyung-button', async () => {
    // 02 스크린샷 확인 결과: "공동·금융인증서" 큰 버튼 하나로 두 인증서 로그인이 통합돼 있음
    await page.getByRole('button', { name: '공동·금융인증서' }).click({ timeout: 10000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT_DIR, '04-cert-select-page.png'), fullPage: true });
    allFrameDumps.push(await dumpFrameInputs(page.mainFrame(), 'main-after-cert-button'));
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        allFrameDumps.push(await dumpFrameInputs(frame, `iframe-after-cert:${frame.name() || frame.url()}`));
      } catch (err) {
        allFrameDumps.push({ label: `iframe-after-cert:${frame.url()}`, error: String(err) });
      }
    }
  });

  await step('07-wait-and-recheck-cert-modal', async () => {
    // "잠시만 기다려 주세요" 로딩 스피너가 실제 인증서 플러그인/위젯 로딩을 기다리는 것인지 확인
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(OUT_DIR, '05-cert-modal-settled.png'), fullPage: true });
    for (const frame of page.frames()) {
      const url = frame.url();
      const name = frame.name();
      if (/cert|dscert|txpp/i.test(name) || /cert/i.test(url)) {
        try {
          const html = await frame.content();
          await writeFile(path.join(OUT_DIR, `frame-${name || 'unnamed'}.html`), html, 'utf-8');
          log.push({ note: `frame ${name} (${url}) HTML 저장됨, 길이=${html.length}` });
        } catch (err) {
          log.push({ note: `frame ${name} content 읽기 실패: ${err}` });
        }
      }
    }
  });

  await step('08-click-fincert-tab-in-modal', async () => {
    // 05 스크린샷 기준 "인증서 선택창" 내부의 위치 탭: 브라우저 / 금융인증서 / 하드디스크·이동식 / 휴대전화 / 스마트인증
    // 좌표 클릭(프레임 경계 불확실하므로 page.mouse 사용, 뷰포트 1440x1000 기준)
    await page.mouse.click(627, 235);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT_DIR, '06-fincert-tab-clicked.png'), fullPage: true });
  });

  const pageText = await page.innerText('body').catch(() => '(failed to read body text)');

  await writeFile(path.join(OUT_DIR, 'frame-dumps.json'), JSON.stringify(allFrameDumps, null, 2), 'utf-8');
  await writeFile(path.join(OUT_DIR, 'run-log.json'), JSON.stringify(log, null, 2), 'utf-8');
  await writeFile(path.join(OUT_DIR, 'page-text.txt'), pageText, 'utf-8');

  await browser.close();
  console.log(`\n완료. ${OUT_DIR} 폴더의 스크린샷/JSON을 확인하세요.`);
}

main().catch((err) => {
  console.error('탐색 스크립트 실패:', err);
  process.exit(1);
});
