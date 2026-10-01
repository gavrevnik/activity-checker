const serbianSpecificLetters = /[čćđšžјљњћђџ]/iu;

export function containsSerbianSpecificLetters(value: string) {
  return serbianSpecificLetters.test(value);
}
