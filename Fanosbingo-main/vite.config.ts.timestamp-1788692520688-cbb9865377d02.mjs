// vite.config.ts
import { defineConfig } from "file:///C:/Users/zekio/OneDrive/Desktop/Sample/Fanosbingo-main/Fanosbingo-main/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/zekio/OneDrive/Desktop/Sample/Fanosbingo-main/Fanosbingo-main/node_modules/@vitejs/plugin-react/dist/index.mjs";
import viteCompression from "file:///C:/Users/zekio/OneDrive/Desktop/Sample/Fanosbingo-main/Fanosbingo-main/node_modules/vite-plugin-compression/dist/index.mjs";
var vite_config_default = defineConfig({
  plugins: [
    react(),
    // Gzip compression
    viteCompression({
      algorithm: "gzip",
      ext: ".gz",
      threshold: 1024
      // Only compress files larger than 1KB
    }),
    // Brotli compression (better than gzip)
    viteCompression({
      algorithm: "brotliCompress",
      ext: ".br",
      threshold: 1024
    })
  ],
  optimizeDeps: {
    exclude: ["lucide-react"]
  },
  build: {
    // Enable source maps for production debugging (optional)
    sourcemap: false,
    // Optimize chunk size
    rollupOptions: {
      output: {
        manualChunks: {
          // Separate vendor code from app code
          "react-vendor": ["react", "react-dom"],
          "supabase-vendor": ["@supabase/supabase-js"],
          "ui-vendor": ["lucide-react"]
        }
      }
    },
    // Increase chunk size warning limit
    chunkSizeWarningLimit: 1e3,
    // Minify with terser for better compression
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: true,
        // Remove console.log in production
        drop_debugger: true
      }
    }
  },
  // Performance optimizations
  server: {
    warmup: {
      clientFiles: ["./src/App.tsx", "./src/screens/BingoScreen.tsx", "./src/components/GameRoom.tsx"]
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFx6ZWtpb1xcXFxPbmVEcml2ZVxcXFxEZXNrdG9wXFxcXFNhbXBsZVxcXFxGYW5vc2JpbmdvLW1haW5cXFxcRmFub3NiaW5nby1tYWluXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFx6ZWtpb1xcXFxPbmVEcml2ZVxcXFxEZXNrdG9wXFxcXFNhbXBsZVxcXFxGYW5vc2JpbmdvLW1haW5cXFxcRmFub3NiaW5nby1tYWluXFxcXHZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9DOi9Vc2Vycy96ZWtpby9PbmVEcml2ZS9EZXNrdG9wL1NhbXBsZS9GYW5vc2JpbmdvLW1haW4vRmFub3NiaW5nby1tYWluL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgcmVhY3QgZnJvbSAnQHZpdGVqcy9wbHVnaW4tcmVhY3QnO1xuaW1wb3J0IHZpdGVDb21wcmVzc2lvbiBmcm9tICd2aXRlLXBsdWdpbi1jb21wcmVzc2lvbic7XG5cbi8vIGh0dHBzOi8vdml0ZWpzLmRldi9jb25maWcvXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbXG4gICAgcmVhY3QoKSxcbiAgICAvLyBHemlwIGNvbXByZXNzaW9uXG4gICAgdml0ZUNvbXByZXNzaW9uKHtcbiAgICAgIGFsZ29yaXRobTogJ2d6aXAnLFxuICAgICAgZXh0OiAnLmd6JyxcbiAgICAgIHRocmVzaG9sZDogMTAyNCwgLy8gT25seSBjb21wcmVzcyBmaWxlcyBsYXJnZXIgdGhhbiAxS0JcbiAgICB9KSxcbiAgICAvLyBCcm90bGkgY29tcHJlc3Npb24gKGJldHRlciB0aGFuIGd6aXApXG4gICAgdml0ZUNvbXByZXNzaW9uKHtcbiAgICAgIGFsZ29yaXRobTogJ2Jyb3RsaUNvbXByZXNzJyxcbiAgICAgIGV4dDogJy5icicsXG4gICAgICB0aHJlc2hvbGQ6IDEwMjQsXG4gICAgfSksXG4gIF0sXG4gIG9wdGltaXplRGVwczoge1xuICAgIGV4Y2x1ZGU6IFsnbHVjaWRlLXJlYWN0J10sXG4gIH0sXG4gIGJ1aWxkOiB7XG4gICAgLy8gRW5hYmxlIHNvdXJjZSBtYXBzIGZvciBwcm9kdWN0aW9uIGRlYnVnZ2luZyAob3B0aW9uYWwpXG4gICAgc291cmNlbWFwOiBmYWxzZSxcblxuICAgIC8vIE9wdGltaXplIGNodW5rIHNpemVcbiAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICBvdXRwdXQ6IHtcbiAgICAgICAgbWFudWFsQ2h1bmtzOiB7XG4gICAgICAgICAgLy8gU2VwYXJhdGUgdmVuZG9yIGNvZGUgZnJvbSBhcHAgY29kZVxuICAgICAgICAgICdyZWFjdC12ZW5kb3InOiBbJ3JlYWN0JywgJ3JlYWN0LWRvbSddLFxuICAgICAgICAgICdzdXBhYmFzZS12ZW5kb3InOiBbJ0BzdXBhYmFzZS9zdXBhYmFzZS1qcyddLFxuICAgICAgICAgICd1aS12ZW5kb3InOiBbJ2x1Y2lkZS1yZWFjdCddLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9LFxuXG4gICAgLy8gSW5jcmVhc2UgY2h1bmsgc2l6ZSB3YXJuaW5nIGxpbWl0XG4gICAgY2h1bmtTaXplV2FybmluZ0xpbWl0OiAxMDAwLFxuXG4gICAgLy8gTWluaWZ5IHdpdGggdGVyc2VyIGZvciBiZXR0ZXIgY29tcHJlc3Npb25cbiAgICBtaW5pZnk6ICd0ZXJzZXInLFxuICAgIHRlcnNlck9wdGlvbnM6IHtcbiAgICAgIGNvbXByZXNzOiB7XG4gICAgICAgIGRyb3BfY29uc29sZTogdHJ1ZSwgLy8gUmVtb3ZlIGNvbnNvbGUubG9nIGluIHByb2R1Y3Rpb25cbiAgICAgICAgZHJvcF9kZWJ1Z2dlcjogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcblxuICAvLyBQZXJmb3JtYW5jZSBvcHRpbWl6YXRpb25zXG4gIHNlcnZlcjoge1xuICAgIHdhcm11cDoge1xuICAgICAgY2xpZW50RmlsZXM6IFsnLi9zcmMvQXBwLnRzeCcsICcuL3NyYy9zY3JlZW5zL0JpbmdvU2NyZWVuLnRzeCcsICcuL3NyYy9jb21wb25lbnRzL0dhbWVSb29tLnRzeCddLFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBb1osU0FBUyxvQkFBb0I7QUFDamIsT0FBTyxXQUFXO0FBQ2xCLE9BQU8scUJBQXFCO0FBRzVCLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVM7QUFBQSxJQUNQLE1BQU07QUFBQTtBQUFBLElBRU4sZ0JBQWdCO0FBQUEsTUFDZCxXQUFXO0FBQUEsTUFDWCxLQUFLO0FBQUEsTUFDTCxXQUFXO0FBQUE7QUFBQSxJQUNiLENBQUM7QUFBQTtBQUFBLElBRUQsZ0JBQWdCO0FBQUEsTUFDZCxXQUFXO0FBQUEsTUFDWCxLQUFLO0FBQUEsTUFDTCxXQUFXO0FBQUEsSUFDYixDQUFDO0FBQUEsRUFDSDtBQUFBLEVBQ0EsY0FBYztBQUFBLElBQ1osU0FBUyxDQUFDLGNBQWM7QUFBQSxFQUMxQjtBQUFBLEVBQ0EsT0FBTztBQUFBO0FBQUEsSUFFTCxXQUFXO0FBQUE7QUFBQSxJQUdYLGVBQWU7QUFBQSxNQUNiLFFBQVE7QUFBQSxRQUNOLGNBQWM7QUFBQTtBQUFBLFVBRVosZ0JBQWdCLENBQUMsU0FBUyxXQUFXO0FBQUEsVUFDckMsbUJBQW1CLENBQUMsdUJBQXVCO0FBQUEsVUFDM0MsYUFBYSxDQUFDLGNBQWM7QUFBQSxRQUM5QjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUE7QUFBQSxJQUdBLHVCQUF1QjtBQUFBO0FBQUEsSUFHdkIsUUFBUTtBQUFBLElBQ1IsZUFBZTtBQUFBLE1BQ2IsVUFBVTtBQUFBLFFBQ1IsY0FBYztBQUFBO0FBQUEsUUFDZCxlQUFlO0FBQUEsTUFDakI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBO0FBQUEsRUFHQSxRQUFRO0FBQUEsSUFDTixRQUFRO0FBQUEsTUFDTixhQUFhLENBQUMsaUJBQWlCLGlDQUFpQywrQkFBK0I7QUFBQSxJQUNqRztBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
