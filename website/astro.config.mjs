// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';

export default defineConfig({
  site: 'https://nas.ptgeek00.com',
  integrations: [
    starlight({
      title: 'ptgeek00 / NAS',
      description:
        'Build log and reference docs for a single-box NAS, media vault, and homelab AI sandbox.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ptgeek00/NAS' },
      ],
      editLink: {
        baseUrl: 'https://github.com/ptgeek00/NAS/edit/main/website/',
      },
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightBlog({
          title: 'Build log',
          authors: {
            ptgeek00: {
              name: 'ptgeek00',
              url: 'https://github.com/ptgeek00',
            },
          },
        }),
      ],
      sidebar: [
        {
          label: 'Overview',
          items: [
            { label: 'Hardware', slug: 'hardware' },
            { label: 'Architecture decisions', slug: 'architecture-decisions' },
          ],
        },
        {
          label: 'Runbooks',
          items: [
            { label: 'Proxmox hostname + TLS', slug: 'proxmox-cert-and-hostname' },
            { label: 'GPU passthrough + Plex', slug: 'gpu-passthrough-plex' },
            { label: 'Jellyfin', slug: 'jellyfin' },
            { label: 'Media storage + SMB', slug: 'media-storage-smb' },
            { label: 'Ollama / local LLM', slug: 'ollama' },
            { label: 'Open WebUI + RAG', slug: 'open-webui' },
            { label: 'Minecraft server', slug: 'minecraft-server' },
          ],
        },
      ],
    }),
    mdx(),
  ],
});
