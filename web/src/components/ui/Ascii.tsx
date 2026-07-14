/** Statik dekoratif ASCII sanat parçaları — boş durum, yükleniyor, section ayraçları için. */

export const ASCII_LOADING = String.raw`
  [■□□□□□□□□□]  BUFFERING...
`;

export const ASCII_LOGO = String.raw`
 ▄▀█ █   █ █ █ █▄▄
 █▀█ █   █▀█ █ █▄█
      H U B
`;

export function AsciiDivider({ label }: { label: string }) {
  return (
    <div className="ascii-art" aria-hidden="true">
      {"·".repeat(2)} {label.toUpperCase()} {"·".repeat(40)}
    </div>
  );
}
