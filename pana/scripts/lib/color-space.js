// OKLab: https://bottosson.github.io/posts/oklab/
// Full-severity Machado et al. (2009) linear-RGB simulations:
// https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html
export const VISION = {
	normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
	protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
	deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
	tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
export const linear = (hex) => hex.match(/[0-9a-f]{2}/gi).map((v) => {
	const c = parseInt(v, 16) / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
export const luminance = (rgb) => rgb[0]*0.2126 + rgb[1]*0.7152 + rgb[2]*0.0722;
export const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
export const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
export function lab([r, g, b]) {
	const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b);
	const m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b);
	const s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
	return [0.2104542553*l + 0.793617785*m - 0.0040720468*s,
		1.9779984951*l - 2.428592205*m + 0.4505937099*s,
		0.0259040371*l + 0.7827717662*m - 0.808675766*s];
}
export function simulatedLabs(hex) {
	const rgb = linear(hex);
	return Object.values(VISION).map((matrix) => lab(matrix.map((row) =>
		Math.max(0, Math.min(1, row.reduce((sum, c, i) => sum + c*rgb[i], 0))))));
}
export function lchHex(l, c, h) {
	const a = c*Math.cos(h*Math.PI/180), b = c*Math.sin(h*Math.PI/180);
	const ll = (l + 0.3963377774*a + 0.2158037573*b)**3;
	const mm = (l - 0.1055613458*a - 0.0638541728*b)**3;
	const ss = (l - 0.0894841775*a - 1.291485548*b)**3;
	const rgb = [4.0767416621*ll - 3.3077115913*mm + 0.2309699292*ss,
		-1.2684380046*ll + 2.6097574011*mm - 0.3413193965*ss,
		-0.0041960863*ll - 0.7034186147*mm + 1.707614701*ss];
	if (rgb.some((v) => v < 0 || v > 1)) return null;
	return '#' + rgb.map((v) => Math.round(255*(v <= 0.0031308 ? 12.92*v : 1.055*v**(1/2.4) - 0.055)).toString(16).padStart(2, '0')).join('').toUpperCase();
}
