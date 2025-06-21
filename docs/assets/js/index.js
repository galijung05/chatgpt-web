// ==============================
// 설정: scenes.json 경로
// ==============================
const SCENES_JSON_PATH = 'scenes.json'; // index.html과 같은 위치에 scenes.json이 있어야 함

// ==============================
// 전역 변수
// ==============================
let scenesData = null;  // { scenes: [...] }
let isGeneratingResponse = false;
let promptToRetry = null;
let uniqueIdToRetry = null;
// loadIntervalMap: responseElement.id -> intervalID (로딩 애니메이션 제어)
const loadIntervalMap = new Map();

// ==============================
// DOM 요소
// ==============================
const submitButton = document.getElementById('submit-button');
const regenerateResponseButton = document.getElementById('regenerate-response-button');
const promptInput = document.getElementById('prompt-input');
const responseList = document.getElementById('response-list');

// modelSelect, whisper-file 등 불필요하면 HTML에서 제거하거나 무시
const modelSelect = document.getElementById('model-select');
const fileInput = document.getElementById("whisper-file");

// ==============================
// 1) 유틸: unique ID 생성
// ==============================
function generateUniqueId() {
    const timestamp = Date.now();
    const randomNumber = Math.random();
    const hex = randomNumber.toString(16).substring(2);
    return `id-${timestamp}-${hex}`;
}

// ==============================
// 2) normalizeText, extractInputKeywords 등 매칭 로직
// ==============================
function normalizeText(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .trim()
      .replace(/[\.·…]/g, '')
      .replace(/[?!,]/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
}

function extractInputKeywords(rawText) {
    const norm = normalizeText(rawText);
    const parts = norm.split(' ').filter(tok => tok.length > 0);
    return Array.from(new Set(parts));
}

function intersectionSize(arr1, arr2) {
    if (!Array.isArray(arr1) || !Array.isArray(arr2)) return 0;
    const set2 = new Set(arr2);
    let count = 0;
    arr1.forEach(item => {
        if (set2.has(item)) count++;
    });
    return count;
}

// includes 기반 간단 매칭(fallback)
function matchesSceneText(scene, rawQuery) {
    if (!rawQuery) return false;
    const q = normalizeText(rawQuery);
    if (scene.onScreenText && normalizeText(scene.onScreenText).includes(q)) return true;
    if (typeof scene.dialogue === 'string' && normalizeText(scene.dialogue).includes(q)) return true;
    if (scene.dialogue && typeof scene.dialogue === 'object') {
        if (scene.dialogue.user && normalizeText(scene.dialogue.user).includes(q)) return true;
        if (scene.dialogue.gpt && normalizeText(scene.dialogue.gpt).includes(q)) return true;
    }
    if (scene.notes && normalizeText(scene.notes).includes(q)) return true;
    if (Array.isArray(scene.keywords)) {
        const inputKeys = q.split(' ').filter(x => x);
        const sceneKeysNorm = scene.keywords.map(k => normalizeText(k));
        if (intersectionSize(inputKeys, sceneKeysNorm) > 0) return true;
    }
    return false;
}

// 최적 매칭: 키워드 교집합 개수 기준
function findBestMatchedSceneByKeywords(scenes, inputText) {
    const inputKeywords = extractInputKeywords(inputText);
    if (inputKeywords.length === 0) return null;
    let bestScene = null;
    let bestScore = 0;
    for (const scene of scenes) {
        // normalizedKeywords 캐싱이 되어 있다면 사용, 아니면 scene.keywords로 처리
        let sceneKeysNorm = [];
        if (Array.isArray(scene.normalizedKeywords)) {
            sceneKeysNorm = scene.normalizedKeywords;
        } else if (Array.isArray(scene.keywords)) {
            sceneKeysNorm = scene.keywords.map(k => normalizeText(k)).filter(x => x);
        }
        const score = intersectionSize(inputKeywords, sceneKeysNorm);
        if (score > bestScore) {
            bestScore = score;
            bestScene = scene;
        } else if (score === bestScore && score > 0) {
            // 동점일 때 ID 작은 씬 우선 (필요시 정책 변경)
            if (bestScene && scene.id < bestScene.id) {
                bestScene = scene;
            }
        }
    }
    if (bestScore <= 0) return null;
    return bestScene;
}

// 다음 씬: matchedScene.id 홀수→id+1, 짝수→id-1
function getNextScene(scenes, matchedScene) {
    if (!matchedScene) return null;
    const id = matchedScene.id;
    let paired = null;
    if (id % 2 === 1) {
        paired = scenes.find(s => s.id === id + 1);
    } else {
        paired = scenes.find(s => s.id === id - 1);
    }
    return paired || null;
}

// ==============================
// 3) UI: addResponse, addEmptyResponse
// ==============================
function addResponse(selfFlag, promptHtml) {
    const uniqueId = generateUniqueId();
    const html = `
        <div class="response-container ${selfFlag ? 'my-question' : 'chatgpt-response'}">
            <img class="avatar-image" src="assets/img/${selfFlag ? 'me' : 'chatgpt'}.png" alt="avatar"/>
            <div class="prompt-content" id="${uniqueId}">${promptHtml || ''}</div>
        </div>
    `;
    responseList.insertAdjacentHTML('beforeend', html);
    responseList.scrollTop = responseList.scrollHeight;
    return uniqueId;
}
// 사용자 질문 표시 시: addResponse(true, 텍스트)
// 응답 자리 만들 때: addResponse(false, '') 로 먼저 빈 div 생성

// ==============================
// 4) “생각중...” 애니메이션
// ==============================
function showLoadingText(element, text = '생각중', speed = 500) {
    element.textContent = '';
    element.classList.add('gradient-text', 'typing-cursor', 'loading-text');
    let dotCount = 0;
    element.textContent = text;
    responseList.scrollTop = responseList.scrollHeight;
    const intervalId = setInterval(() => {
        dotCount = (dotCount + 1) % 4; // 0,1,2,3
        const dots = '.'.repeat(dotCount);
        element.textContent = text + dots;
        responseList.scrollTop = responseList.scrollHeight;
    }, speed);
    return intervalId;
}

// ==============================
// 5) 한 글자씩 타이핑 애니메이션
// ==============================
function typeText(element, text, speed = 50, callback) {
    element.textContent = '';
    let index = 0;
    const length = text.length;
    element.classList.add('gradient-text', 'typing-cursor');
    const timer = setInterval(() => {
        const char = text.charAt(index);
        if (char === '\n') {
            element.appendChild(document.createElement('br'));
        } else {
            element.textContent += char;
        }
        index++;
        responseList.scrollTop = responseList.scrollHeight;
        if (index >= length) {
            clearInterval(timer);
            element.classList.remove('typing-cursor');
            if (callback) callback();
        }
    }, speed);
}

// ==============================
// 6) 에러 메시지 표시
// ==============================
function setErrorForResponse(element, message) {
    element.innerHTML = message;
    element.style.color = 'rgb(200, 0, 0)';
}

// ==============================
// 7) 재시도 설정 (필요시)
// ==============================
function setRetryResponse(prompt, uniqueId) {
    promptToRetry = prompt;
    uniqueIdToRetry = uniqueId;
    regenerateResponseButton.style.display = 'flex';
}

// ==============================
// 8) 순수 클라이언트 매칭 함수
// ==============================
async function getClientMatchResult(_promptToRetry, _uniqueIdToRetry) {
    const prompt = _promptToRetry ?? promptInput.textContent.trim();
    if (isGeneratingResponse || !prompt) {
        return;
    }
    isGeneratingResponse = true;
    submitButton.classList.add("loading");
    promptInput.textContent = '';

    // 1) 사용자 질문 표시
    if (!_uniqueIdToRetry) {
        addResponse(true, `<div>${prompt}</div>`);
    }
    // 2) 응답 자리 생성
    const uniqueId = _uniqueIdToRetry ?? addResponse(false, '');
    const responseElement = document.getElementById(uniqueId);

    // 3) “생각중...” 표시 및 최소 1초 보장
    if (loadIntervalMap.has(uniqueId)) {
        clearInterval(loadIntervalMap.get(uniqueId));
        loadIntervalMap.delete(uniqueId);
    }
    const startTime = Date.now();
    const intervalId = showLoadingText(responseElement, '생각중', 500);
    loadIntervalMap.set(uniqueId, intervalId);
    const minLoading = 1000; // 최소 1초

    try {
        // 즉시 매칭 수행
        const matched = findBestMatchedSceneByKeywords(scenesData.scenes, prompt);
        // fallback: includes 매칭
        let actualMatched = matched;
        if (!actualMatched) {
            const fallback = scenesData.scenes.find(s => matchesSceneText(s, prompt));
            actualMatched = fallback || null;
        }
        const paired = actualMatched ? getNextScene(scenesData.scenes, actualMatched) : null;

        const elapsed = Date.now() - startTime;
        const waitTime = Math.max(0, minLoading - elapsed);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        // 4) “생각중...” 제거
        clearInterval(intervalId);
        loadIntervalMap.delete(uniqueId);
        responseElement.classList.remove('loading-text', 'typing-cursor');
        responseElement.textContent = '';

        // 5) 결과 결정
        let outputText = '';
        if (!actualMatched) {
            outputText = '매칭되는 씬을 찾을 수 없습니다.';
        } else if (!paired) {
            outputText = '다음 씬이 없습니다.';
        } else {
            outputText = paired.onScreenText || '';
        }
        // 6) 한 글자씩 타이핑
        typeText(responseElement, outputText, 50, () => {
            // 완료 후: 필요시 후속 처리
        });

        promptToRetry = null;
        uniqueIdToRetry = null;
        regenerateResponseButton.style.display = 'none';
    } catch (err) {
        // 에러 처리: “생각중...” 제거 후 에러 표시
        const elapsed2 = Date.now() - startTime;
        if (elapsed2 < minLoading) {
            await new Promise(resolve => setTimeout(resolve, minLoading - elapsed2));
        }
        clearInterval(intervalId);
        loadIntervalMap.delete(uniqueId);
        responseElement.classList.remove('gradient-text', 'typing-cursor', 'loading-text');
        setRetryResponse(prompt, uniqueId);
        setErrorForResponse(responseElement, `Error: ${err.message}`);
    } finally {
        isGeneratingResponse = false;
        submitButton.classList.remove("loading");
    }
}

// ==============================
// 9) 이벤트 바인딩
// ==============================
submitButton.addEventListener("click", () => {
    getClientMatchResult();
});
regenerateResponseButton.addEventListener("click", () => {
    if (promptToRetry && uniqueIdToRetry) {
        getClientMatchResult(promptToRetry, uniqueIdToRetry);
    }
});
promptInput.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.shiftKey) {
            document.execCommand('insertHTML', false, '<br/><br/>');
        } else {
            getClientMatchResult();
        }
    }
});

// ==============================
// 10) scenes.json 로드 및 초기화
// ==============================
async function loadScenes() {
    try {
        const res = await fetch(SCENES_JSON_PATH);
        if (!res.ok) throw new Error(`Failed to load scenes.json: ${res.status}`);
        const parsed = await res.json();
        if (!Array.isArray(parsed.scenes)) {
            console.error('scenes.json 형식 오류: "scenes" 필드가 배열이어야 합니다.');
            scenesData = { scenes: [] };
        } else {
            // normalizedKeywords 캐싱
            parsed.scenes.forEach(scene => {
                if (Array.isArray(scene.keywords)) {
                    scene.normalizedKeywords = scene.keywords
                        .map(k => normalizeText(k))
                        .filter(x => x);
                } else {
                    scene.normalizedKeywords = [];
                }
            });
            scenesData = parsed;
            console.log(`Loaded scenes.json: ${scenesData.scenes.length} scenes`);
        }
    } catch (err) {
        console.error(err);
        scenesData = { scenes: [] };
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    // scenes.json 불러오기
    await loadScenes();
    // 초점 설정
    promptInput.focus();
});
