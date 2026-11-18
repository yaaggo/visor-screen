// visor-audio.exe — helper nativo do Visor (Windows 10 build 20348+ / Windows 11).
//
//   visor-audio list                 JSON: apps com sessao de audio  [{pid, exe, path, title, active}]
//   visor-audio capture <pid>        PCM float32 LE, 48 kHz, estereo, no stdout (so o processo <pid> e filhos)
//   visor-audio capture <pid> exclude   idem, mas TUDO menos o processo <pid> e filhos (audio do sistema sem eco)
//   visor-audio winpid <hwnd>        pid dono da janela
//
// Usa a API oficial de Application Loopback (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK).
// Build: electron/native/build.cmd (MSVC).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <psapi.h>
#include <wrl/implements.h>
#include <wrl/client.h>
#include <fcntl.h>
#include <io.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <set>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "user32.lib")

using Microsoft::WRL::ComPtr;

static const UINT32 RATE = 48000;
static const UINT16 CHANNELS = 2;

// ---------- utilidades ----------

static std::string utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

static std::string json(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c < 0x20) {
      char b[8];
      sprintf_s(b, "\\u%04x", c);
      o += b;
    } else o += (char)c;
  }
  return o + "\"";
}

static std::wstring processPath(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return {};
  wchar_t buf[MAX_PATH * 2];
  DWORD len = (DWORD)std::size(buf);
  std::wstring out;
  if (QueryFullProcessImageNameW(h, 0, buf, &len)) out.assign(buf, len);
  CloseHandle(h);
  return out;
}

struct FindWin {
  DWORD pid;
  std::wstring title;
};

static BOOL CALLBACK findWindow(HWND hwnd, LPARAM lp) {
  auto* f = reinterpret_cast<FindWin*>(lp);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid != f->pid || !IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
  wchar_t t[512];
  int n = GetWindowTextW(hwnd, t, 512);
  if (n > 0) {
    f->title.assign(t, n);
    return FALSE;
  }
  return TRUE;
}

// ---------- list ----------

static int cmdList() {
  ComPtr<IMMDeviceEnumerator> en;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) return 2;
  ComPtr<IMMDeviceCollection> devices;
  if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) return 2;

  UINT count = 0;
  devices->GetCount(&count);
  std::set<DWORD> seen;
  DWORD self = GetCurrentProcessId();
  std::string out = "[";
  bool first = true;

  for (UINT d = 0; d < count; d++) {
    ComPtr<IMMDevice> dev;
    if (FAILED(devices->Item(d, &dev))) continue;
    ComPtr<IAudioSessionManager2> mgr;
    if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)mgr.GetAddressOf()))) continue;
    ComPtr<IAudioSessionEnumerator> sessions;
    if (FAILED(mgr->GetSessionEnumerator(&sessions))) continue;
    int n = 0;
    sessions->GetCount(&n);
    for (int i = 0; i < n; i++) {
      ComPtr<IAudioSessionControl> ctl;
      if (FAILED(sessions->GetSession(i, &ctl))) continue;
      ComPtr<IAudioSessionControl2> ctl2;
      if (FAILED(ctl.As(&ctl2))) continue;
      if (ctl2->IsSystemSoundsSession() == S_OK) continue;
      DWORD pid = 0;
      ctl2->GetProcessId(&pid);
      if (!pid || pid == self || seen.count(pid)) continue;
      AudioSessionState state = AudioSessionStateInactive;
      ctl->GetState(&state);
      if (state == AudioSessionStateExpired) continue;
      seen.insert(pid);

      std::wstring path = processPath(pid);
      std::wstring exe = path.substr(path.find_last_of(L"\\/") + 1);
      FindWin fw{pid, {}};
      EnumWindows(findWindow, (LPARAM)&fw);

      if (!first) out += ",";
      first = false;
      out += "{\"pid\":" + std::to_string(pid) + ",\"exe\":" + json(utf8(exe)) + ",\"path\":" + json(utf8(path)) +
             ",\"title\":" + json(utf8(fw.title)) + ",\"active\":" + (state == AudioSessionStateActive ? "true" : "false") + "}";
    }
  }
  out += "]";
  fwrite(out.data(), 1, out.size(), stdout);
  return 0;
}

// ---------- capture ----------

class Activation : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                                       Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT hr = E_FAIL;
  ComPtr<IAudioClient> client;

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activateHr = E_FAIL;
    ComPtr<IUnknown> unk;
    hr = op->GetActivateResult(&activateHr, &unk);
    if (SUCCEEDED(hr)) hr = activateHr;
    if (SUCCEEDED(hr)) hr = unk.As(&client);
    SetEvent(done);
    return S_OK;
  }
};

static int cmdCapture(DWORD pid, bool exclude) {
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      exclude ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT pv{};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto handler = Microsoft::WRL::Make<Activation>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op);
  if (FAILED(hr)) {
    fprintf(stderr, "activate 0x%08lx\n", hr);
    return 3;
  }
  WaitForSingleObject(handler->done, INFINITE);
  if (FAILED(handler->hr)) {
    fprintf(stderr, "activate result 0x%08lx\n", handler->hr);
    return 3;
  }
  ComPtr<IAudioClient> client = handler->client;

  // Tenta float32; se o sistema recusar, cai para PCM16 e converte.
  WAVEFORMATEX fmt{};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  fmt.nChannels = CHANNELS;
  fmt.nSamplesPerSec = RATE;
  fmt.wBitsPerSample = 32;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
  bool isFloat = true;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, &fmt, nullptr);
  if (FAILED(hr)) {
    isFloat = false;
    fmt.wFormatTag = WAVE_FORMAT_PCM;
    fmt.wBitsPerSample = 16;
    fmt.nBlockAlign = fmt.nChannels * 2;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, &fmt, nullptr);
  }
  if (FAILED(hr)) {
    fprintf(stderr, "initialize 0x%08lx\n", hr);
    return 4;
  }

  HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  client->SetEventHandle(ev);
  ComPtr<IAudioCaptureClient> cap;
  if (FAILED(client->GetService(IID_PPV_ARGS(&cap)))) return 4;
  if (FAILED(client->Start())) return 4;

  std::vector<float> buf;
  for (;;) {
    WaitForSingleObject(ev, 200);
    UINT32 packet = 0;
    while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD f = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &f, nullptr, nullptr))) break;
      buf.assign((size_t)frames * CHANNELS, 0.0f);
      if (!(f & AUDCLNT_BUFFERFLAGS_SILENT)) {
        if (isFloat) memcpy(buf.data(), data, buf.size() * sizeof(float));
        else {
          auto* s = reinterpret_cast<int16_t*>(data);
          for (size_t i = 0; i < buf.size(); i++) buf[i] = s[i] / 32768.0f;
        }
      }
      cap->ReleaseBuffer(frames);
      if (fwrite(buf.data(), sizeof(float), buf.size(), stdout) != buf.size() || fflush(stdout) != 0) return 0;  // pai fechou
    }
  }
}

int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
  if (argc < 2) {
    fprintf(stderr, "uso: visor-audio list | capture <pid> [exclude] | winpid <hwnd>\n");
    return 1;
  }
  std::wstring cmd = argv[1];
  if (cmd == L"list") return cmdList();
  if (cmd == L"capture" && argc >= 3) return cmdCapture((DWORD)_wtoi(argv[2]), argc >= 4 && std::wstring(argv[3]) == L"exclude");
  if (cmd == L"winpid" && argc >= 3) {
    DWORD pid = 0;
    GetWindowThreadProcessId((HWND)(intptr_t)_wtoi64(argv[2]), &pid);
    printf("%lu", pid);
    return 0;
  }
  return 1;
}
