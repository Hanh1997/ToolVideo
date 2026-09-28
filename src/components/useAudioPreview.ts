import { useEffect } from "react";
import { AudioEngine } from "../engine/AudioEngine";
import { useEditor } from "../store/editorStore";

/** Đồng bộ audio preview với trạng thái phát của editor (play / pause / seek / đổi scene). */
export function useAudioPreview(): void {
  useEffect(() => {
    const audio = new AudioEngine();
    const initial = useEditor.getState();
    if (initial.scene && initial.registry) audio.load(initial.scene, initial.registry);
    audio.setMuted(initial.muted);

    const unsub = useEditor.subscribe((s, prev) => {
      if (s.scene !== prev.scene && s.scene && s.registry) audio.load(s.scene, s.registry);
      if (s.muted !== prev.muted) audio.setMuted(s.muted);
      const restart = s.playing && (!prev.playing || s.seekId !== prev.seekId || s.scene !== prev.scene);
      if (restart) void audio.start(s.time);
      else if (!s.playing && prev.playing) audio.stop();
    });

    return () => {
      unsub();
      audio.dispose();
    };
  }, []);
}
