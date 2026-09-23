import {
  ChatsCircleIcon,
  HashIcon,
  ImageSquareIcon,
  MegaphoneIcon,
  MicrophoneStageIcon,
  SpeakerHighIcon,
} from "@phosphor-icons/react";

const size = 15;
const weight = "bold" as const;

export function ChannelIcon({ type }: { type: string | undefined }) {
  switch (type) {
    case "voice":
      return <SpeakerHighIcon size={size} weight={weight} aria-hidden />;
    case "announcement":
      return <MegaphoneIcon size={size} weight={weight} aria-hidden />;
    case "forum":
      return <ChatsCircleIcon size={size} weight={weight} aria-hidden />;
    case "media":
      return <ImageSquareIcon size={size} weight={weight} aria-hidden />;
    case "stage":
      return <MicrophoneStageIcon size={size} weight={weight} aria-hidden />;
    default:
      return <HashIcon size={size} weight={weight} aria-hidden />;
  }
}
